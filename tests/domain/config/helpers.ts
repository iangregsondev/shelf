import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ShelfConfig, defaultConfig } from "../../../src/domain/config/config-schema";
import type { RepoEntry } from "../../../src/domain/config/config-schema";
import type { ConfigParseError, ConfigWriteError } from "../../../src/domain/config/config-errors";
import { ConfigService } from "../../../src/domain/config/config-service";

export type ConfigOverrides = {
	readonly load?: () => Effect.Effect<typeof ShelfConfig.Type, ConfigParseError>;
	readonly save?: (config: typeof ShelfConfig.Type) => Effect.Effect<void, ConfigWriteError>;
	readonly ensureDirectories?: () => Effect.Effect<void, ConfigWriteError>;
	readonly repoPath?: (alias: string) => string;
};

const defaultConfigImpl = {
	load: (): Effect.Effect<typeof ShelfConfig.Type, ConfigParseError> =>
		Effect.succeed(defaultConfig),
	save: (): Effect.Effect<void, ConfigWriteError> => Effect.void,
	ensureDirectories: (): Effect.Effect<void, ConfigWriteError> => Effect.void,
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
	const { save, repoPath, ...impl } = { ...defaultConfigImpl, ...overrides };
	const update = <E = never>(
		fn: (current: ShelfConfig) => ShelfConfig | Effect.Effect<ShelfConfig, E>,
	): Effect.Effect<ShelfConfig, ConfigParseError | ConfigWriteError | E> =>
		Effect.gen(function* () {
			const result = fn(yield* impl.load());
			const next = Effect.isEffect(result) ? yield* result : result;
			yield* save(next);
			return next;
		});
	const updateRepo = <E = never>(
		alias: string,
		fn: (repo: RepoEntry, current: ShelfConfig) => RepoEntry | Effect.Effect<RepoEntry, E>,
	): Effect.Effect<Option.Option<RepoEntry>, ConfigParseError | ConfigWriteError | E> =>
		Effect.gen(function* () {
			const current = yield* impl.load();
			const repo = current.repos.find((r) => r.alias === alias);
			if (repo === undefined) return Option.none();
			const result = fn(repo, current);
			const next = Effect.isEffect(result) ? yield* result : result;
			yield* save(
				new ShelfConfig({
					...current,
					repos: current.repos.map((r) => (r.alias === alias ? next : r)),
				}),
			);
			return Option.some(next);
		});
	return Layer.succeed(
		ConfigService,
		ConfigService.of({
			...impl,
			repoPath: (alias: string) => Effect.succeed(repoPath(alias)),
			update,
			updateRepo,
		}),
	);
};
