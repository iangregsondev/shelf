import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ShelfConfig } from "../../../src/domain/config/config-schema";
import { defaultConfig } from "../../../src/domain/config/config-schema";
import type { ConfigParseError } from "../../../src/domain/config/config-errors";
import { ConfigService } from "../../../src/domain/config/config-service";

export type ConfigOverrides = {
	readonly load?: () => Effect.Effect<typeof ShelfConfig.Type, ConfigParseError>;
	readonly save?: (config: typeof ShelfConfig.Type) => Effect.Effect<void, ConfigParseError>;
	readonly ensureDirectories?: () => Effect.Effect<void, ConfigParseError>;
	readonly repoPath?: (alias: string) => string;
};

const defaultConfigImpl = {
	load: (): Effect.Effect<typeof ShelfConfig.Type, ConfigParseError> =>
		Effect.succeed(defaultConfig),
	save: (): Effect.Effect<void, ConfigParseError> => Effect.void,
	ensureDirectories: (): Effect.Effect<void, ConfigParseError> => Effect.void,
	repoPath: (alias: string): string => `/tmp/shelf-test/repos/${alias}`,
	shelfHome: "/tmp/shelf-test",
	reposDir: "/tmp/shelf-test/repos",
	configPath: "/tmp/shelf-test/config.json",
};

/**
 * A config layer whose `update` applies `fn` to `load()` and hands the result
 * to the `save` override (a spy; the real service has no public save).
 */
export const createMockConfigLayer = (
	overrides: ConfigOverrides = {},
): Layer.Layer<ConfigService> => {
	const { save, ...impl } = { ...defaultConfigImpl, ...overrides };
	const update = <E = never>(
		fn: (current: ShelfConfig) => ShelfConfig | Effect.Effect<ShelfConfig, E>,
	): Effect.Effect<ShelfConfig, ConfigParseError | E> =>
		Effect.gen(function* () {
			const result = fn(yield* impl.load());
			const next = Effect.isEffect(result) ? yield* result : result;
			yield* save(next);
			return next;
		});
	return Layer.succeed(ConfigService, ConfigService.of({ ...impl, update }));
};
