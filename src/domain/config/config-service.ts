import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import { FileSystem } from "effect/FileSystem";
import { join } from "node:path";
import { homedir } from "node:os";
import type { RepoEntry } from "./config-schema";
import { ShelfConfig, defaultConfig, decodeConfig, encodeConfig } from "./config-schema";
import { ConfigParseError, ConfigWriteError, type InvalidAliasError } from "./config-errors";
import { checkAlias, resolveShelfHome } from "./config-utils";
import { readFileIfExists } from "./file-store";
import { withStateFileLock, writeFileAtomic } from "./state-file-store";

export class ConfigService extends Context.Service<ConfigService>()(
  "shelf/domain/config/ConfigService",
  {
    make: Effect.gen(function* () {
      const fs = yield* FileSystem;
      const shelfHome = resolveShelfHome(process.env, homedir(), process.cwd());
      const configFile = join(shelfHome, "config.json");
      const reposDir = join(shelfHome, "repos");

      const load = Effect.fn("ConfigService.load")(function* () {
        const text = yield* readFileIfExists(fs, configFile).pipe(
          Effect.mapError(
            (error) =>
              new ConfigParseError({
                message:
                  error.stage === "check"
                    ? "Failed to check config file"
                    : "Failed to read config file",
              }),
          ),
        );
        if (Option.isNone(text)) {
          return defaultConfig;
        }
        const raw = yield* Effect.try({
          try: (): unknown => JSON.parse(text.value),
          catch: (error) =>
            new ConfigParseError({
              reason: "invalid-json",
              message: `config.json is not valid JSON: ${String((error as Error).message)}`,
            }),
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
       * to abort the update without saving, or give back the config it was
       * handed to save nothing. Returns the saved config.
       */
      const update = <E = never>(
        fn: (current: ShelfConfig) => ShelfConfig | Effect.Effect<ShelfConfig, E>,
      ): Effect.Effect<ShelfConfig, ConfigParseError | ConfigWriteError | E> =>
        Effect.gen(function* () {
          const current = yield* load();
          const result = fn(current);
          const next = Effect.isEffect(result) ? yield* result : result;
          if (next !== current) {
            yield* save(next);
          }
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
          yield* fs.makeDirectory(shelfHome, { recursive: true }).pipe(
            Effect.andThen(fs.makeDirectory(reposDir, { recursive: true })),
            Effect.mapError(
              () => new ConfigWriteError({ message: "Failed to create shelf directories" }),
            ),
          );
        }),

        /**
         * The folder of the reference repo `alias`. Fails, naming no path,
         * when the alias is not a single safe folder name (say, a hand-edited
         * `../x` in config.json), so nothing ever acts outside the repos folder.
         */
        repoPath: (alias: string): Effect.Effect<string, InvalidAliasError> =>
          checkAlias(alias).pipe(Effect.map((safe) => join(reposDir, safe))),

        shelfHome,
        reposDir,
        configPath: configFile,
      };
    }),
  },
) {
  static layer = Layer.effect(this, this.make);
}
