import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Context from "effect/Context";
import { mkdir, rename as renamePath, rm as removePath } from "node:fs/promises";
import { join } from "node:path";
import { RepoEntry, RepoPin, ShelfConfig } from "../config/config-schema";
import { ConfigService } from "../config/config-service";
import { checkAlias, errorCode } from "../config/config-utils";
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
} from "./repo-errors";
import { deriveAlias, parsePin, pinFromRemoteRefs } from "./repo-utils";
import { stripSemverRange, parseRemoteTags, findMatchingTag } from "./pin-utils";
import { dirSize, listFolder, pathExists } from "./repo-store";

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
				yield* Effect.tryPromise({
					try: () => mkdir(targetDir),
					catch: (error) =>
						errorCode(error) === "EEXIST"
							? new RepoAlreadyExistsError({ alias: resolvedAlias })
							: new RepoFolderError({
									path: targetDir,
									message: error instanceof Error ? error.message : String(error),
								}),
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
				const repoDir = yield* config.repoPath(repo.alias);
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

			/**
			 * Renames a reference repo: its folder, its config entry and its manual
			 * registry entry. If the config can't follow, the folder is moved back,
			 * so the two never disagree.
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
				// rename() silently replaces an empty folder, so refuse any folder already there.
				if (yield* pathExists(newPath)) {
					return yield* new AliasRenameError({
						from,
						to,
						message: `a folder already exists at ${newPath}`,
					});
				}
				yield* Effect.tryPromise({
					try: () => renamePath(oldPath, newPath),
					catch: (error) =>
						new AliasRenameError({
							from,
							to,
							message: error instanceof Error ? error.message : String(error),
						}),
				});
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
						Effect.onError(() =>
							Effect.tryPromise(() => renamePath(newPath, oldPath)).pipe(Effect.ignore),
						),
					);
				yield* registry.renameManual(from, to);
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
