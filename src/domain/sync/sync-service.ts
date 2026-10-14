import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Context from "effect/Context";
import { RepoEntry } from "../config/config-schema";
import type {
  ConfigParseError,
  ConfigWriteError,
  InvalidAliasError,
} from "../config/config-errors";
import { ConfigService } from "../config/config-service";
import type { GitOperationError } from "../git/git-errors";
import { GitService } from "../git/git-service";

/** Why syncing one reference repo failed. */
export type SyncError = GitOperationError | ConfigParseError | ConfigWriteError | InvalidAliasError;

/** A reference repo that failed to sync, and the error it failed with. */
export interface SyncFailure {
  readonly alias: string;
  readonly error: SyncError;
}

export interface SyncAllResult {
  /** How many reference repos the sync tried. */
  readonly total: number;
  readonly failures: ReadonlyArray<SyncFailure>;
}

export class SyncService extends Context.Service<SyncService>()("shelf/domain/sync/SyncService", {
  make: Effect.gen(function* () {
    const config = yield* ConfigService;
    const git = yield* GitService;

    // Fetches only what the pin needs, then checks it out. Branch and tag pins
    // (and unpinned repos) fetch their ref shallowly; a commit pin fetches its
    // commit only when missing, never with a depth, so the clone never becomes
    // shallower than it is.
    const syncCheckout = (
      repoDir: string,
      repo: RepoEntry,
    ): Effect.Effect<void, GitOperationError> =>
      Effect.gen(function* () {
        const depth = Option.some(Option.getOrElse(repo.depth, () => 1));
        const syncBranch = (branch: string): Effect.Effect<void, GitOperationError> =>
          Effect.gen(function* () {
            const remoteRef = `refs/remotes/origin/${branch}`;
            yield* git.fetch(repoDir, `+refs/heads/${branch}:${remoteRef}`, depth);
            yield* git.checkout(repoDir, remoteRef);
          });
        if (Option.isNone(repo.pin)) {
          yield* syncBranch(yield* git.getDefaultBranch(repoDir));
        } else if (repo.pin.value.type === "branch") {
          yield* syncBranch(repo.pin.value.value);
        } else if (repo.pin.value.type === "tag") {
          const tagRef = `refs/tags/${repo.pin.value.value}`;
          yield* git.fetch(repoDir, `+${tagRef}:${tagRef}`, depth);
          yield* git.checkout(repoDir, tagRef);
        } else {
          const commit = repo.pin.value.value;
          yield* git.ensureCommit(repoDir, commit);
          yield* git.checkout(repoDir, commit);
        }
      });

    const doSync = (repo: RepoEntry): Effect.Effect<void, SyncError> =>
      Effect.gen(function* () {
        const repoDir = yield* config.repoPath(repo.alias);
        yield* syncCheckout(repoDir, repo);
        const now = new Date().toISOString();
        // A repo removed while it synced stays removed: None saves nothing.
        yield* config.updateRepo(
          repo.alias,
          (r) => new RepoEntry({ ...r, lastSyncedAt: Option.some(now) }),
        );
      });

    return {
      syncRepo: Effect.fn("SyncService.syncRepo")(function* (repo: RepoEntry) {
        yield* doSync(repo);
      }),

      // Syncs every reference repo, up to four at a time, carrying on past
      // failures, and reports which ones failed (in config order) so the
      // caller can show them.
      syncAll: Effect.fn("SyncService.syncAll")(function* () {
        const cfg = yield* config.load();
        const outcomes = yield* Effect.forEach(
          cfg.repos,
          (repo) =>
            doSync(repo).pipe(
              Effect.as(Option.none<SyncFailure>()),
              Effect.catch((error) => Effect.succeed(Option.some({ alias: repo.alias, error }))),
            ),
          { concurrency: 4 },
        );
        const failures = outcomes.flatMap((outcome) => Option.toArray(outcome));
        const result: SyncAllResult = { total: cfg.repos.length, failures };
        return result;
      }),
    };
  }),
}) {
  static layer = Layer.effect(this, this.make);
}
