import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import { join } from "node:path";
import { homedir } from "node:os";
import type { RepoEntry } from "./config-schema";
import { ShelfConfig, defaultConfig, decodeConfig, encodeConfig } from "./config-schema";
import { ConfigParseError, ConfigWriteError } from "./config-errors";
import { resolveShelfHome } from "./config-utils";
import { withStateFileLock, writeFileAtomic } from "./state-file-store";

export class ConfigService extends Context.Service<ConfigService>()(
	"shelf/domain/config/ConfigService",
	{
		make: Effect.gen(function* () {
			const shelfHome = resolveShelfHome(process.env, homedir(), process.cwd());
			const configFile = join(shelfHome, "config.json");
			const reposDir = join(shelfHome, "repos");

			const load = Effect.fn("ConfigService.load")(function* () {
				const file = Bun.file(configFile);
				const exists = yield* Effect.tryPromise({
					try: () => file.exists(),
					catch: () => new ConfigParseError({ message: "Failed to check config file" }),
				});
				if (!exists) {
					return defaultConfig;
				}
				const raw = yield* Effect.tryPromise({
					try: () => file.json(),
					catch: () => new ConfigParseError({ message: "Failed to read config file" }),
				});
				return yield* Effect.try({
					try: () => decodeConfig(raw),
					catch: () => new ConfigParseError({ message: "Invalid config schema" }),
				});
			});

			const save = (config: ShelfConfig): Effect.Effect<void, ConfigWriteError> =>
				Effect.tryPromise({
					try: () => writeFileAtomic(configFile, JSON.stringify(encodeConfig(config), null, "\t")),
					catch: () => new ConfigWriteError({ message: "Failed to write config file" }),
				});

			const locked = withStateFileLock(configFile, (message) => new ConfigWriteError({ message }));

			/**
			 * Reads the config, applies `fn` and saves the result, holding the
			 * in-process and cross-process config locks throughout. `fn` may fail
			 * to abort the update without saving. Returns the saved config.
			 */
			const update = <E = never>(
				fn: (current: ShelfConfig) => ShelfConfig | Effect.Effect<ShelfConfig, E>,
			): Effect.Effect<ShelfConfig, ConfigParseError | ConfigWriteError | E> =>
				Effect.gen(function* () {
					const current = yield* load();
					const result = fn(current);
					const next = Effect.isEffect(result) ? yield* result : result;
					yield* save(next);
					return next;
				}).pipe(locked, Effect.withSpan("ConfigService.update"));

			/**
			 * Like `update`, for one reference repo: applies `fn` to the repo stored
			 * under `alias` (and the whole config, for checks) and saves the result.
			 * Gives `None`, saving nothing, when no repo has that alias.
			 */
			const updateRepo = <E = never>(
				alias: string,
				fn: (repo: RepoEntry, current: ShelfConfig) => RepoEntry | Effect.Effect<RepoEntry, E>,
			): Effect.Effect<Option.Option<RepoEntry>, ConfigParseError | ConfigWriteError | E> =>
				Effect.gen(function* () {
					const current = yield* load();
					const repo = current.repos.find((r: RepoEntry) => r.alias === alias);
					if (repo === undefined) return Option.none();
					const result = fn(repo, current);
					const next = Effect.isEffect(result) ? yield* result : result;
					yield* save(
						new ShelfConfig({
							...current,
							repos: current.repos.map((r: RepoEntry) => (r.alias === alias ? next : r)),
						}),
					);
					return Option.some(next);
				}).pipe(locked, Effect.withSpan("ConfigService.updateRepo"));

			return {
				load,
				update,
				updateRepo,

				ensureDirectories: Effect.fn("ConfigService.ensureDirectories")(function* () {
					yield* Effect.tryPromise({
						try: async () => {
							const { mkdir } = await import("node:fs/promises");
							await mkdir(shelfHome, { recursive: true });
							await mkdir(reposDir, { recursive: true });
						},
						catch: () => new ConfigWriteError({ message: "Failed to create shelf directories" }),
					});
				}),

				repoPath: (alias: string): string => join(reposDir, alias),

				shelfHome,
				reposDir,
				configPath: configFile,
			};
		}),
	},
) {
	static layer = Layer.effect(this, this.make);
}
