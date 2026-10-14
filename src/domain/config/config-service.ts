import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ShelfConfig } from "./config-schema";
import { defaultConfig, decodeConfig, encodeConfig } from "./config-schema";
import { ConfigParseError } from "./config-errors";
import { resolveShelfHome } from "./config-utils";
import { withStateFileLock, writeFileAtomic } from "./state-file-utils";

export class ConfigService extends Context.Service<ConfigService>()(
	"shelf/domain/config/ConfigService",
	{
		make: Effect.gen(function* () {
			const shelfDir = resolveShelfHome(process.env, homedir(), process.cwd());
			const configFile = join(shelfDir, "config.json");
			const reposDir = join(shelfDir, "repos");

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

			const save = (config: ShelfConfig): Effect.Effect<void, ConfigParseError> =>
				Effect.tryPromise({
					try: () => writeFileAtomic(configFile, JSON.stringify(encodeConfig(config), null, "\t")),
					catch: () => new ConfigParseError({ message: "Failed to write config file" }),
				});

			/**
			 * Reads the config, applies `fn` and saves the result, holding the
			 * in-process and cross-process config locks throughout. `fn` may fail
			 * to abort the update without saving. Returns the saved config.
			 */
			const update = <E = never>(
				fn: (current: ShelfConfig) => ShelfConfig | Effect.Effect<ShelfConfig, E>,
			): Effect.Effect<ShelfConfig, ConfigParseError | E> =>
				Effect.gen(function* () {
					const current = yield* load();
					const result = fn(current);
					const next = Effect.isEffect(result) ? yield* result : result;
					yield* save(next);
					return next;
				}).pipe(
					withStateFileLock(configFile, (message) => new ConfigParseError({ message })),
					Effect.withSpan("ConfigService.update"),
				);

			return {
				load,
				update,

				ensureDirectories: Effect.fn("ConfigService.ensureDirectories")(function* () {
					yield* Effect.tryPromise({
						try: async () => {
							const { mkdir } = await import("node:fs/promises");
							await mkdir(shelfDir, { recursive: true });
							await mkdir(reposDir, { recursive: true });
						},
						catch: () => new ConfigParseError({ message: "Failed to create shelf directories" }),
					});
				}),

				repoPath: (alias: string): string => join(reposDir, alias),

				configDir: shelfDir,
				reposDir,
				configPath: configFile,
			};
		}),
	},
) {
	static layer = Layer.effect(this, this.make);
}
