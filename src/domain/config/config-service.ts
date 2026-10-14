import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ShelfConfig } from "./config-schema";
import { defaultConfig, decodeConfig, encodeConfig } from "./config-schema";
import { ConfigParseError } from "./config-errors";
import { resolveShelfHome } from "./config-utils";

export class ConfigService extends Context.Service<ConfigService>()(
	"shelf/domain/config/ConfigService",
	{
		make: Effect.gen(function* () {
			const shelfDir = resolveShelfHome(process.env, homedir(), process.cwd());
			const configFile = join(shelfDir, "config.json");
			const reposDir = join(shelfDir, "repos");

			return {
				load: Effect.fn("ConfigService.load")(function* () {
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
				}),

				save: Effect.fn("ConfigService.save")(function* (config: typeof ShelfConfig.Type) {
					const encoded = encodeConfig(config);
					yield* Effect.tryPromise({
						try: async () => {
							const tmpPath = `${configFile}.tmp`;
							await Bun.write(tmpPath, JSON.stringify(encoded, null, "\t"));
							const { rename } = await import("node:fs/promises");
							await rename(tmpPath, configFile);
						},
						catch: () => new ConfigParseError({ message: "Failed to write config file" }),
					});
				}),

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
