import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Context from "effect/Context";
import { FileSystem } from "effect/FileSystem";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { RepoEntry, RepoPin, ShelfConfig } from "../config/config-schema";
import { ConfigService } from "../config/config-service";
import { checkAlias, errorCode, osError, osErrorMessage } from "../config/config-utils";
import type { GitOperationError } from "../git/git-errors";
import { GitService } from "../git/git-service";
import { RegistryService } from "../registry/registry-service";
import { SyncService, type SyncAllResult } from "../sync/sync-service";
import {
  AliasRenameError,
  AutoPinResolutionError,
  PinResolutionError,
  RepoAlreadyExistsError,
  RepoFolderError,
  RepoNotFoundError,
  RepoRemoveError,
} from "./repo-errors";
import { declaredVersion, deriveAlias, parsePin, pinFromRemoteRefs } from "./repo-utils";
import { stripSemverRange, parseRemoteTags, findMatchingTag } from "./pin-utils";
import { dirSize, listFolder, pathExists, sameFolder } from "./repo-store";

/** What `RepoService.remove` removed. */
export interface RemovedRepo {
  readonly alias: string;
  /** True when only a folder was there, with no config entry for it. */
  readonly orphan: boolean;
}

/** What is on disk for a reference repo. */
export interface RepoFolder {
  readonly path: string;
  readonly exists: boolean;
  /** Total bytes of every file in the folder; 0 when it is missing. */
  readonly sizeBytes: number;
  /** Names directly inside the folder; empty when it is missing. */
  readonly contents: ReadonlyArray<string>;
}

/** What `RepoService.add` clones; every field but `url` defaults to none. */
export interface AddRepoOptions {
  readonly url: string;
  /** Defaults to an alias derived from `url`. */
  readonly alias?: Option.Option<string>;
  readonly pin?: Option.Option<RepoPin>;
  readonly depth?: Option.Option<number>;
  readonly sparse?: Option.Option<ReadonlyArray<string>>;
}

export class RepoService extends Context.Service<RepoService>()("shelf/domain/repo/RepoService", {
  make: Effect.gen(function* () {
    const fs = yield* FileSystem;
    const config = yield* ConfigService;
    const git = yield* GitService;
    const sync = yield* SyncService;
    const registry = yield* RegistryService;

    /**
     * Turns a pin the user typed into a pin. Explicit forms are taken as
     * stated; a bare value is a tag pin if `url` has that tag, else a branch
     * pin if it has that branch. A commit pin may still be a short hash.
     */
    const resolvePin = Effect.fn("RepoService.resolvePin")(function* (url: string, raw: string) {
      const input = parsePin(raw);
      if (input._tag === "Invalid") {
        return yield* new PinResolutionError({ message: input.message });
      }
      if (input._tag === "Explicit") {
        return input.pin;
      }
      const pin = pinFromRemoteRefs(input.value, yield* git.lsRemoteRefs(url));
      if (pin === undefined) {
        return yield* new PinResolutionError({
          message: `"${input.value}" is neither a tag nor a branch on ${url}. Use commit:<hash> for a commit.`,
        });
      }
      return pin;
    });

    /** A commit pin as its full hash, read from the local clone at `repoDir`. */
    const fullCommitPin = (
      repoDir: string,
      hash: string,
    ): Effect.Effect<RepoPin, GitOperationError> =>
      git
        .resolveCommit(repoDir, hash)
        .pipe(Effect.map((full) => new RepoPin({ type: "commit", value: full })));

    return {
      resolvePin,

      /**
       * Pins a reference repo, saving the pin only once a sync to it has
       * worked, so a pin that can't be checked out is never stored. A commit
       * the clone lacks is fetched first, so a short hash can be expanded.
       */
      pin: Effect.fn("RepoService.pin")(function* (alias: string, raw: string) {
        const cfg = yield* config.load();
        const repo = cfg.repos.find((r: RepoEntry) => r.alias === alias);
        if (!repo) {
          return yield* new RepoNotFoundError({ alias });
        }
        const repoDir = yield* config.repoPath(alias);
        let resolved = yield* resolvePin(repo.url, raw);
        if (resolved.type === "commit") {
          yield* git.ensureCommit(repoDir, resolved.value);
          resolved = yield* fullCommitPin(repoDir, resolved.value);
        }
        yield* sync.syncRepo(new RepoEntry({ ...repo, pin: Option.some(resolved) }));
        const saved = yield* config.updateRepo(
          alias,
          (r) => new RepoEntry({ ...r, pin: Option.some(resolved) }),
        );
        if (Option.isNone(saved)) {
          return yield* new RepoNotFoundError({ alias });
        }
        return resolved;
      }),

      add: Effect.fn("RepoService.add")(function* (options: AddRepoOptions) {
        const { url } = options;
        const alias = options.alias ?? Option.none();
        const pin = options.pin ?? Option.none();
        const depth = options.depth ?? Option.none();
        const sparse = options.sparse ?? Option.none();
        const resolvedAlias = yield* checkAlias(Option.getOrElse(alias, () => deriveAlias(url)));
        yield* config.ensureDirectories();
        const cfg = yield* config.load();
        if (cfg.repos.some((r: RepoEntry) => r.alias === resolvedAlias)) {
          return yield* new RepoAlreadyExistsError({ alias: resolvedAlias });
        }
        const targetDir = yield* config.repoPath(resolvedAlias);
        // Claim the folder before cloning, so a failed add only ever removes
        // a folder it created itself. The clone runs outside the config lock;
        // only the config write takes turns with other adds.
        yield* fs
          .makeDirectory(targetDir)
          .pipe(
            Effect.mapError((error) =>
              errorCode(osError(error)) === "EEXIST"
                ? new RepoAlreadyExistsError({ alias: resolvedAlias })
                : new RepoFolderError({ path: targetDir, message: osErrorMessage(error) }),
            ),
          );
        yield* Effect.gen(function* () {
          yield* git.clone(url, targetDir, pin, depth, sparse);
          // A commit pin is stored as its full hash, read from the fresh clone.
          const storedPin =
            Option.isSome(pin) && pin.value.type === "commit"
              ? Option.some(yield* fullCommitPin(targetDir, pin.value.value))
              : pin;
          const now = new Date().toISOString();
          const newRepo = new RepoEntry({
            url,
            alias: resolvedAlias,
            pin: storedPin,
            depth,
            sparse,
            addedAt: now,
            lastSyncedAt: Option.some(now),
          });
          yield* config.update((current) =>
            current.repos.some((r: RepoEntry) => r.alias === resolvedAlias)
              ? Effect.fail(new RepoAlreadyExistsError({ alias: resolvedAlias }))
              : Effect.succeed(new ShelfConfig({ ...current, repos: [...current.repos, newRepo] })),
          );
        }).pipe(
          Effect.onError(() =>
            fs.remove(targetDir, { recursive: true, force: true }).pipe(Effect.ignore),
          ),
        );
        return resolvedAlias;
      }),

      /**
       * Removes a reference repo: its folder, then its config entry. A folder
       * with no config entry (an orphan, which would block `add`) is removed
       * too. If the folder can't be deleted, the config entry is kept.
       */
      remove: Effect.fn("RepoService.remove")(function* (aliasOrUrl: string) {
        const deleteFolder = (alias: string, path: string) =>
          fs
            .remove(path, { recursive: true, force: true })
            .pipe(
              Effect.mapError(
                (error) => new RepoRemoveError({ alias, path, message: osErrorMessage(error) }),
              ),
            );
        const cfg = yield* config.load();
        const repo = cfg.repos.find(
          (r: RepoEntry) => r.alias === aliasOrUrl || r.url === aliasOrUrl,
        );
        if (!repo) {
          // A URL or unsafe name is never an orphan folder's alias.
          const orphanDir = yield* checkAlias(aliasOrUrl).pipe(
            Effect.flatMap(config.repoPath),
            Effect.option,
          );
          if (Option.isNone(orphanDir) || !(yield* pathExists(orphanDir.value))) {
            return yield* new RepoNotFoundError({ alias: aliasOrUrl });
          }
          yield* deleteFolder(aliasOrUrl, orphanDir.value);
          const removed: RemovedRepo = { alias: aliasOrUrl, orphan: true };
          return removed;
        }
        yield* deleteFolder(repo.alias, yield* config.repoPath(repo.alias));
        yield* config.update(
          (current) =>
            new ShelfConfig({
              ...current,
              repos: current.repos.filter((r: RepoEntry) => r.alias !== repo.alias),
            }),
        );
        const removed: RemovedRepo = { alias: repo.alias, orphan: false };
        return removed;
      }),

      /**
       * Renames a reference repo: its folder, its config entry and its manual
       * registry entry. If the config can't follow, the folder is moved back;
       * if the registry can't, the config entry and the folder are both moved
       * back, so the three never disagree.
       */
      rename: Effect.fn("RepoService.rename")(function* (from: string, to: string) {
        yield* checkAlias(to);
        const cfg = yield* config.load();
        if (!cfg.repos.some((r: RepoEntry) => r.alias === from)) {
          return yield* new RepoNotFoundError({ alias: from });
        }
        if (cfg.repos.some((r: RepoEntry) => r.alias === to)) {
          return yield* new RepoAlreadyExistsError({ alias: to });
        }
        const oldPath = yield* config.repoPath(from);
        const newPath = yield* config.repoPath(to);
        // rename() silently replaces an empty folder, so refuse any folder
        // already there. On a case-insensitive file system a case-only rename
        // (react -> React) finds the repo's own folder there: that one is fine.
        if ((yield* pathExists(newPath)) && !(yield* sameFolder(oldPath, newPath))) {
          return yield* new AliasRenameError({
            from,
            to,
            message: `a folder already exists at ${newPath}`,
          });
        }
        // A case-only rename goes through a temp name, so the file system
        // can't treat it as a no-op.
        const caseOnly = oldPath.toLowerCase() === newPath.toLowerCase();
        const moveFolder = (src: string, dst: string) => {
          if (!caseOnly) {
            return fs.rename(src, dst);
          }
          const tmp = join(dirname(dst), `.shelf-rename-${randomUUID()}`);
          return fs.rename(src, tmp).pipe(
            Effect.andThen(
              fs.rename(tmp, dst).pipe(
                /* v8 ignore next -- unreachable in tests: dst was freed by the first step */
                Effect.onError(() => fs.rename(tmp, src).pipe(Effect.ignore)),
              ),
            ),
          );
        };
        const moveBack = moveFolder(newPath, oldPath).pipe(Effect.ignore);
        yield* moveFolder(oldPath, newPath).pipe(
          Effect.mapError(
            (error) => new AliasRenameError({ from, to, message: osErrorMessage(error) }),
          ),
        );
        yield* config
          .updateRepo(from, (repo, current) =>
            current.repos.some((r: RepoEntry) => r.alias === to)
              ? Effect.fail(new RepoAlreadyExistsError({ alias: to }))
              : Effect.succeed(new RepoEntry({ ...repo, alias: to })),
          )
          .pipe(
            Effect.flatMap((saved) =>
              Option.isNone(saved)
                ? Effect.fail(new RepoNotFoundError({ alias: from }))
                : Effect.void,
            ),
            Effect.onError(() => moveBack),
          );
        yield* registry.renameManual(from, to).pipe(
          Effect.onError(() =>
            config
              .updateRepo(to, (repo) => new RepoEntry({ ...repo, alias: from }))
              .pipe(
                // Move the folder back only once the config points at it again.
                Effect.flatMap((restored) => (Option.isSome(restored) ? moveBack : Effect.void)),
                Effect.ignore,
              ),
          ),
        );
      }),

      /** Total bytes of every file in the reference repo `alias`'s folder; 0 when it is missing. */
      size: Effect.fn("RepoService.size")(function* (alias: string) {
        return yield* dirSize(yield* config.repoPath(alias));
      }),

      /** What is on disk for the reference repo `alias`. */
      folder: Effect.fn("RepoService.folder")(function* (alias: string) {
        const path = yield* config.repoPath(alias);
        const exists = yield* pathExists(path);
        const result: RepoFolder = {
          path,
          exists,
          sizeBytes: exists ? yield* dirSize(path) : 0,
          contents: exists ? yield* listFolder(path) : [],
        };
        return result;
      }),

      list: Effect.fn("RepoService.list")(function* () {
        const cfg = yield* config.load();
        return cfg.repos;
      }),

      resolveAutoPin: Effect.fn("RepoService.resolveAutoPin")(function* (
        url: string,
        packageName: string,
      ) {
        const noPackageJson = (): AutoPinResolutionError =>
          new AutoPinResolutionError({
            message: "No package.json found in current directory",
          });
        const pkgText = yield* fs
          .readFileString(join(process.cwd(), "package.json"))
          .pipe(Effect.mapError(noPackageJson));
        const pkgJson = yield* Effect.try({
          try: () => JSON.parse(pkgText) as Record<string, unknown> | null,
          catch: noPackageJson,
        });
        const version = declaredVersion(pkgJson, packageName);
        if (!version) {
          return yield* new AutoPinResolutionError({
            message: `Package "${packageName}" not found in dependencies or devDependencies`,
          });
        }
        const lsRemoteOutput = yield* git.lsRemoteTags(url);
        const remoteTags = parseRemoteTags(lsRemoteOutput);
        // findMatchingTag strips the semver range itself.
        const matchedTag = findMatchingTag(packageName, version, remoteTags);
        if (!matchedTag) {
          return yield* new AutoPinResolutionError({
            message: `No matching tag found for ${packageName}@${stripSemverRange(version)}`,
          });
        }
        return Option.some(new RepoPin({ type: "tag", value: matchedTag }));
      }),

      // With an alias, a failed sync fails the update. Without one, every
      // reference repo is synced and the failures come back in the result.
      sync: Effect.fn("RepoService.sync")(function* (alias: Option.Option<string>) {
        if (Option.isSome(alias)) {
          const cfg = yield* config.load();
          const repo = cfg.repos.find((r: RepoEntry) => r.alias === alias.value);
          if (!repo) {
            return yield* new RepoNotFoundError({ alias: alias.value });
          }
          yield* sync.syncRepo(repo);
          const result: SyncAllResult = { total: 1, failures: [] };
          return result;
        }
        return yield* sync.syncAll();
      }),
    };
  }),
}) {
  static layer = Layer.effect(this, this.make);
}
