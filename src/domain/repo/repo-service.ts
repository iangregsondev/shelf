import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Context from "effect/Context";
import { FileSystem } from "effect/FileSystem";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { RepoEntry, RepoPin, ShelfConfig } from "../config/config-schema";
import { ConfigService } from "../config/config-service";
import { checkAlias, osErrorMessage } from "../config/config-utils";
import { isProcessAlive } from "../config/state-file-store";
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
import {
  declaredVersion,
  deriveAlias,
  parsePin,
  parseTempName,
  pinFromRemoteRefs,
  tempName,
  tempPrefix,
  type TempKind,
} from "./repo-utils";
import { stripSemverRange, parseRemoteTags, findMatchingTag } from "./pin-utils";
import { dirSize, listFolder, pathExists, sameFolder } from "./repo-store";

/** A trash folder that could not be deleted. */
export interface TrashLeft {
  readonly path: string;
  readonly message: string;
}

/** What `RepoService.remove` removed. */
export interface RemovedRepo {
  readonly alias: string;
  /** True when only a folder was there, with no config entry for it. */
  readonly orphan: boolean;
  /** Trash folders, this repo's or older ones, that could not be deleted. */
  readonly trashLeft: ReadonlyArray<TrashLeft>;
}

/**
 * A temp folder beside the repo folder `path`, for `kind` of work on it by
 * this process (see `tempName`).
 */
const tempSibling = (path: string, kind: TempKind): string =>
  join(dirname(path), tempName(kind, basename(path), process.pid, randomUUID()));

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

    /**
     * Settles dead temp folders: those of adds, removes and case-only
     * renames whose process is gone. A dead remove's or rename's folder
     * moves back to the repo folder of a config entry it belongs to, when
     * that folder is missing (it died partway); every other one becomes
     * trash. A folder that can't be moved comes back for
     * a warning; the next remove or prune tries again. A PID from another
     * PID namespace (a repos folder shared with a container) reads as gone.
     */
    const settleDeadTempFolders = Effect.gen(function* () {
      const dead = (yield* listFolder(config.reposDir)).flatMap((name) => {
        const temp = parseTempName(name);
        return temp !== undefined && temp.kind !== "trash" && !isProcessAlive(temp.pid)
          ? [{ ...temp, path: join(config.reposDir, name) }]
          : [];
      });
      const left: TrashLeft[] = [];
      if (dead.length === 0) {
        return left;
      }
      // Under the config lock, so no add, remove or rename changes entries
      // or repo folders while a dead folder is checked and moved.
      yield* config.update((current) =>
        Effect.gen(function* () {
          for (const temp of dead) {
            // The entries this folder may belong back to: a remove's own
            // alias, or a case-only rename's alias in either spelling (the
            // config may hold the old one or the new one). An add's folder
            // belongs to none: its entry is only saved once it is in place.
            const owners = current.repos.filter((r: RepoEntry) =>
              temp.kind === "removing"
                ? r.alias === temp.alias
                : temp.kind === "rename" && r.alias.toLowerCase() === temp.alias.toLowerCase(),
            );
            // It moves back only into an owner whose repo folder is missing.
            let to: string | undefined;
            for (const owner of owners) {
              // A hand-edited alias may be unsafe; such an entry never gets a folder.
              const repoDir = Option.getOrUndefined(
                yield* config.repoPath(owner.alias).pipe(Effect.option),
              );
              if (repoDir !== undefined && !(yield* pathExists(repoDir))) {
                to = repoDir;
                break;
              }
            }
            // Named from reposDir, not tempSibling, which an unsafe alias would break.
            to ??= join(config.reposDir, tempName("trash", temp.alias, process.pid, randomUUID()));
            yield* fs.rename(temp.path, to).pipe(
              Effect.catch((error) =>
                Effect.sync(() => {
                  left.push({ path: temp.path, message: osErrorMessage(error) });
                }),
              ),
            );
          }
          // Unchanged, so nothing is saved.
          return current;
        }),
      );
      return left;
      // A config that can't be read or locked now is settled on the next try.
    }).pipe(Effect.orElseSucceed((): ReadonlyArray<TrashLeft> => []));

    /**
     * Deletes every trash folder under the repos folder, after turning dead
     * temp folders into trash (`settleDeadTempFolders`). A failed delete is
     * not an error: the folder is already off the shelf, and the next remove
     * or prune tries again. Gives every folder it could not deal with.
     */
    const clearTrash = Effect.fn("RepoService.clearTrash")(function* () {
      const left: TrashLeft[] = [...(yield* settleDeadTempFolders)];
      const names = yield* listFolder(config.reposDir);
      for (const name of names.filter((n) => n.startsWith(tempPrefix("trash")))) {
        const path = join(config.reposDir, name);
        yield* fs.remove(path, { recursive: true, force: true }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              left.push({ path, message: osErrorMessage(error) });
            }),
          ),
        );
      }
      return left;
    });

    return {
      clearTrash,
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
        // rename() silently replaces an empty folder, so refuse any folder
        // already at the alias, before cloning and again before the rename.
        const failIfTaken = Effect.gen(function* () {
          if (yield* pathExists(targetDir)) {
            return yield* new RepoAlreadyExistsError({ alias: resolvedAlias });
          }
        });
        yield* failIfTaken;
        // Clone into a temp folder, so `remove` never takes a half-made clone
        // for an orphan folder. The clone runs outside the config lock; the
        // rename into place and the config write run under it, so `remove`
        // sees the repo folder only once it has a config entry.
        const cloneDir = tempSibling(targetDir, "add");
        const folderError = (path: string) => (error: unknown) =>
          new RepoFolderError({ path, message: osErrorMessage(error) });
        yield* fs.makeDirectory(cloneDir).pipe(Effect.mapError(folderError(cloneDir)));
        // Set once the clone is in place. A failed add then moves it back
        // before deleting it, so a delete that fails partway never leaves a
        // half-deleted folder under the alias.
        let placed = false;
        yield* Effect.gen(function* () {
          yield* git.clone(url, cloneDir, pin, depth, sparse);
          // A commit pin is stored as its full hash, read from the fresh clone.
          const storedPin =
            Option.isSome(pin) && pin.value.type === "commit"
              ? Option.some(yield* fullCommitPin(cloneDir, pin.value.value))
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
            Effect.gen(function* () {
              if (current.repos.some((r: RepoEntry) => r.alias === resolvedAlias)) {
                return yield* new RepoAlreadyExistsError({ alias: resolvedAlias });
              }
              yield* failIfTaken;
              yield* fs.rename(cloneDir, targetDir).pipe(Effect.mapError(folderError(targetDir)));
              placed = true;
              return new ShelfConfig({ ...current, repos: [...current.repos, newRepo] });
            }),
          );
        }).pipe(
          Effect.onError(() =>
            (placed ? fs.rename(targetDir, cloneDir) : Effect.void).pipe(
              Effect.andThen(fs.remove(cloneDir, { recursive: true, force: true })),
              Effect.ignore,
            ),
          ),
        );
        return resolvedAlias;
      }),

      /**
       * Removes a reference repo: its folder, then its config entry. A folder
       * with no config entry (an orphan, which would block `add`) is removed
       * too. The folder is first renamed aside, which is all or nothing: if
       * that fails, the folder and the config entry are both kept. Once the
       * config is saved, the folder becomes trash, and all trash is deleted;
       * what can't be deleted comes back in `trashLeft`, for the next remove
       * or prune to try again.
       */
      remove: Effect.fn("RepoService.remove")(function* (aliasOrUrl: string) {
        // Set once the folder is moved aside. Until the config is saved it
        // keeps a "removing" name, which `clearTrash` never deletes, so a
        // failed config write can always move it back.
        let moved: { readonly from: string; readonly to: string } | undefined;
        const moveAside = Effect.fn("RepoService.moveAside")(function* (
          alias: string,
          path: string,
        ) {
          // A repo whose folder is already gone just loses its entry.
          if (!(yield* pathExists(path))) {
            return;
          }
          const aside = tempSibling(path, "removing");
          yield* fs
            .rename(path, aside)
            .pipe(
              Effect.mapError(
                (error) => new RepoRemoveError({ alias, path, message: osErrorMessage(error) }),
              ),
            );
          moved = { from: path, to: aside };
        });
        let found: Omit<RemovedRepo, "trashLeft"> | undefined;
        // Under the config lock, so an add can't move a folder into place
        // between the orphan check and the move aside. The slow delete runs
        // after the lock is released.
        yield* config
          .update((current) =>
            Effect.gen(function* () {
              const repo = current.repos.find(
                (r: RepoEntry) => r.alias === aliasOrUrl || r.url === aliasOrUrl,
              );
              if (repo) {
                yield* moveAside(repo.alias, yield* config.repoPath(repo.alias));
                found = { alias: repo.alias, orphan: false };
                return new ShelfConfig({
                  ...current,
                  repos: current.repos.filter((r: RepoEntry) => r.alias !== repo.alias),
                });
              }
              // A URL or unsafe name is never an orphan folder's alias.
              const orphanDir = yield* checkAlias(aliasOrUrl).pipe(
                Effect.flatMap(config.repoPath),
                Effect.option,
              );
              if (Option.isNone(orphanDir) || !(yield* pathExists(orphanDir.value))) {
                return yield* new RepoNotFoundError({ alias: aliasOrUrl });
              }
              yield* moveAside(aliasOrUrl, orphanDir.value);
              found = { alias: aliasOrUrl, orphan: true };
              // Unchanged, so nothing is saved.
              return current;
            }),
          )
          .pipe(
            Effect.onError(() =>
              moved === undefined
                ? Effect.void
                : fs.rename(moved.to, moved.from).pipe(Effect.ignore),
            ),
          );
        const trashLeft: TrashLeft[] = [];
        if (moved !== undefined) {
          const { from, to } = moved;
          yield* fs.rename(to, tempSibling(from, "trash")).pipe(
            /* v8 ignore next -- unreachable in tests: the folder was renamed in the same parent moments before */
            Effect.catch((error) =>
              Effect.sync(() => trashLeft.push({ path: to, message: osErrorMessage(error) })),
            ),
          );
        }
        trashLeft.push(...(yield* clearTrash()));
        // `found` is set on every path where the update succeeds.
        const removed: RemovedRepo = { ...found!, trashLeft };
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
          const tmp = tempSibling(dst, "rename");
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
