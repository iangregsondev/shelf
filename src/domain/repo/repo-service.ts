import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Context from "effect/Context";
import { mkdir, rm as removePath } from "node:fs/promises";
import { join } from "node:path";
import { RepoEntry, RepoPin, ShelfConfig } from "../config/config-schema";
import { ConfigParseError } from "../config/config-errors";
import { ConfigService } from "../config/config-service";
import { errorCode } from "../config/config-utils";
import type { GitOperationError } from "../git/git-errors";
import { GitService } from "../git/git-service";
import { SyncService, type SyncAllResult } from "../sync/sync-service";
import {
	AutoPinResolutionError,
	PinResolutionError,
	RepoAlreadyExistsError,
	RepoNotFoundError,
} from "./repo-errors";
import { checkAlias, deriveAlias, parsePin, pinFromRemoteRefs } from "./repo-utils";
import { stripSemverRange, parseRemoteTags, findMatchingTag } from "./pin-utils";

export class RepoService extends Context.Service<RepoService>()("shelf/domain/repo/RepoService", {
	make: Effect.gen(function* () {
		const config = yield* ConfigService;
		const git = yield* GitService;
		const sync = yield* SyncService;

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
				const repoDir = config.repoPath(alias);
				let resolved = yield* resolvePin(repo.url, raw);
				if (resolved.type === "commit") {
					const hash = resolved.value;
					if (!(yield* git.hasCommit(repoDir, hash))) {
						// A full hash can be fetched by itself; a short one only by
						// fetching the history it sits in.
						yield* hash.length === 40
							? git.fetch(repoDir, hash, Option.none())
							: git.fetchHistory(repoDir);
					}
					resolved = yield* fullCommitPin(repoDir, hash);
				}
				yield* sync.syncRepo(new RepoEntry({ ...repo, pin: Option.some(resolved) }));
				yield* config.update((current) =>
					current.repos.some((r: RepoEntry) => r.alias === alias)
						? Effect.succeed(
								new ShelfConfig({
									...current,
									repos: current.repos.map((r: RepoEntry) =>
										r.alias === alias ? new RepoEntry({ ...r, pin: Option.some(resolved) }) : r,
									),
								}),
							)
						: Effect.fail(new RepoNotFoundError({ alias })),
				);
				return resolved;
			}),

			add: Effect.fn("RepoService.add")(function* (
				url: string,
				alias: Option.Option<string>,
				pin: Option.Option<RepoPin>,
				depth: Option.Option<number>,
				sparse: Option.Option<ReadonlyArray<string>>,
			) {
				const resolvedAlias = yield* checkAlias(Option.getOrElse(alias, () => deriveAlias(url)));
				yield* config.ensureDirectories();
				const cfg = yield* config.load();
				if (cfg.repos.some((r: RepoEntry) => r.alias === resolvedAlias)) {
					return yield* new RepoAlreadyExistsError({ alias: resolvedAlias });
				}
				const targetDir = config.repoPath(resolvedAlias);
				// Claim the folder before cloning, so a failed add only ever removes
				// a folder it created itself. The clone runs outside the config lock;
				// only the config write takes turns with other adds.
				yield* Effect.tryPromise({
					try: () => mkdir(targetDir),
					catch: (error) =>
						errorCode(error) === "EEXIST"
							? new RepoAlreadyExistsError({ alias: resolvedAlias })
							: new ConfigParseError({ message: `Failed to create ${targetDir}` }),
				});
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
						Effect.tryPromise(() => removePath(targetDir, { recursive: true, force: true })).pipe(
							Effect.ignore,
						),
					),
				);
				return resolvedAlias;
			}),

			remove: Effect.fn("RepoService.remove")(function* (aliasOrUrl: string) {
				const cfg = yield* config.load();
				const repo = cfg.repos.find(
					(r: RepoEntry) => r.alias === aliasOrUrl || r.url === aliasOrUrl,
				);
				if (!repo) {
					return yield* new RepoNotFoundError({ alias: aliasOrUrl });
				}
				const repoDir = config.repoPath(repo.alias);
				yield* Effect.tryPromise({
					try: () => removePath(repoDir, { recursive: true, force: true }),
					catch: () => undefined,
				}).pipe(Effect.ignore);
				yield* config.update(
					(current) =>
						new ShelfConfig({
							...current,
							repos: current.repos.filter((r: RepoEntry) => r.alias !== repo.alias),
						}),
				);
				return repo.alias;
			}),

			list: Effect.fn("RepoService.list")(function* () {
				const cfg = yield* config.load();
				return cfg.repos;
			}),

			resolveAutoPin: Effect.fn("RepoService.resolveAutoPin")(function* (
				url: string,
				packageName: string,
			) {
				const pkgJson = yield* Effect.tryPromise({
					try: async () => {
						const file = Bun.file(join(process.cwd(), "package.json"));
						return (await file.json()) as Record<string, unknown>;
					},
					catch: () =>
						new AutoPinResolutionError({
							message: "No package.json found in current directory",
						}),
				});
				const deps = (pkgJson["dependencies"] ?? {}) as Record<string, string>;
				const devDeps = (pkgJson["devDependencies"] ?? {}) as Record<string, string>;
				const version = deps[packageName] ?? devDeps[packageName];
				if (!version) {
					return yield* new AutoPinResolutionError({
						message: `Package "${packageName}" not found in dependencies or devDependencies`,
					});
				}
				const stripped = stripSemverRange(version);
				const lsRemoteOutput = yield* git.lsRemoteTags(url);
				const remoteTags = parseRemoteTags(lsRemoteOutput);
				const matchedTag = findMatchingTag(packageName, stripped, remoteTags);
				if (!matchedTag) {
					return yield* new AutoPinResolutionError({
						message: `No matching tag found for ${packageName}@${stripped}`,
					});
				}
				return Option.some(new RepoPin({ type: "tag", value: matchedTag }));
			}),

			// With an alias, a failed sync fails the update. Without one, every
			// reference repo is synced and the failures come back in the result.
			update: Effect.fn("RepoService.update")(function* (alias: Option.Option<string>) {
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
