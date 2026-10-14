import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Context from "effect/Context";
import { RepoEntry, ShelfConfig } from "../config/config-schema";
import { ConfigService } from "../config/config-service";
import type { GitOperationError } from "../git/git-errors";
import { GitService } from "../git/git-service";

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
					if (!(yield* git.hasCommit(repoDir, commit))) {
						yield* git.fetch(repoDir, commit, Option.none());
					}
					yield* git.checkout(repoDir, commit);
				}
			});

		const doSync = (repo: RepoEntry): Effect.Effect<void, unknown, never> =>
			Effect.gen(function* () {
				const repoDir = config.repoPath(repo.alias);
				yield* syncCheckout(repoDir, repo);
				const now = new Date().toISOString();
				yield* config.update(
					(cfg) =>
						new ShelfConfig({
							...cfg,
							repos: cfg.repos.map((r: RepoEntry) =>
								r.alias === repo.alias
									? new RepoEntry({ ...r, lastSyncedAt: Option.some(now) })
									: r,
							),
						}),
				);
			});

		return {
			syncRepo: Effect.fn("SyncService.syncRepo")(function* (repo: RepoEntry) {
				yield* doSync(repo);
			}),

			syncAll: Effect.fn("SyncService.syncAll")(function* () {
				const cfg = yield* config.load();
				for (const repo of cfg.repos) {
					yield* doSync(repo).pipe(
						Effect.catch((error: unknown) =>
							Effect.logWarning("Sync failed for repo").pipe(
								Effect.annotateLogs({
									alias: repo.alias,
									error: String(error),
								}),
							),
						),
					);
				}
			}),
		};
	}),
}) {
	static layer = Layer.effect(this, this.make);
}
