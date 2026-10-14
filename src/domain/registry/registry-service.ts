import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import { FileSystem } from "effect/FileSystem";
import { isAbsolute, join, resolve } from "node:path";
import { ConfigService } from "../config/config-service";
import { errorCode, osError, osErrorMessage } from "../config/config-utils";
import { ShelffileService } from "../shelffile/shelffile-service";
import { ShelfRegistry, defaultRegistry, decodeRegistry, encodeRegistry } from "./registry-schema";
import { RegistryParseError, RegistryWriteError } from "./registry-errors";
import { readJsonIfExists } from "../config/file-store";
import { withStateFileLock, writeFileAtomic } from "../config/state-file-store";

const REGISTRY_FILE = "registry.json";

/** What prune needs to know about which reference repos are still wanted. */
export interface ReferenceScan {
  /** Aliases the manual list or a project's shelffile references. */
  readonly aliases: ReadonlySet<string>;
  /**
   * True when some project's references couldn't be worked out at all, so any
   * repo might still be wanted.
   */
  readonly anyMightBeReferenced: boolean;
  /**
   * Registry entries to drop: the folder no longer exists. A relative path
   * (recorded by an older shelf) is never dropped, since it can't be checked.
   */
  readonly staleProjects: ReadonlyArray<string>;
  /** Problems reading projects, one line each. */
  readonly warnings: ReadonlyArray<string>;
}

type ProjectState = "present" | "missing" | { readonly unknown: string };

/** "missing" only when the folder is definitely gone. */
const projectState = (fs: FileSystem, dir: string): Effect.Effect<ProjectState> =>
  fs.stat(dir).pipe(
    Effect.as<ProjectState>("present"),
    Effect.catch((error) => {
      const code = errorCode(osError(error));
      if (code === "ENOENT" || code === "ENOTDIR") return Effect.succeed<ProjectState>("missing");
      return Effect.succeed<ProjectState>({ unknown: osErrorMessage(error) });
    }),
  );

export class RegistryService extends Context.Service<RegistryService>()(
  "shelf/domain/registry/RegistryService",
  {
    make: Effect.gen(function* () {
      const fs = yield* FileSystem;
      const config = yield* ConfigService;
      const shelffile = yield* ShelffileService;

      const registryPath = join(config.shelfHome, REGISTRY_FILE);

      const load = Effect.fn("RegistryService.load")(function* () {
        const raw = yield* readJsonIfExists(fs, registryPath).pipe(
          Effect.mapError(
            (error) =>
              new RegistryParseError({
                message:
                  error.stage === "check"
                    ? "Failed to check registry file"
                    : "Failed to read registry file",
              }),
          ),
        );
        if (Option.isNone(raw)) {
          return defaultRegistry;
        }
        return yield* Effect.try({
          try: () => decodeRegistry(raw.value),
          catch: () => new RegistryParseError({ message: "Invalid registry schema" }),
        });
      });

      const save = (registry: ShelfRegistry): Effect.Effect<void, RegistryWriteError> =>
        Effect.tryPromise({
          try: () =>
            writeFileAtomic(registryPath, JSON.stringify(encodeRegistry(registry), null, "\t")),
          catch: () => new RegistryWriteError({ message: "Failed to write registry file" }),
        });

      /**
       * Reads the registry, applies `fn` and saves the result, holding the
       * in-process and cross-process registry locks throughout. Returns the
       * saved registry.
       */
      const update = (
        fn: (current: ShelfRegistry) => ShelfRegistry,
      ): Effect.Effect<ShelfRegistry, RegistryParseError | RegistryWriteError> =>
        Effect.gen(function* () {
          const next = fn(yield* load());
          yield* save(next);
          return next;
        }).pipe(
          withStateFileLock(registryPath, (message) => new RegistryWriteError({ message })),
          Effect.withSpan("RegistryService.update"),
        );

      return {
        load,
        update,

        /**
         * Records the absolute project folder `dir`, replacing any relative
         * entry an older shelf recorded for it (one that resolves to `dir`
         * from this working directory).
         */
        registerProject: Effect.fn("RegistryService.registerProject")(function* (dir: string) {
          const cwd = process.cwd();
          yield* update((registry) => {
            const kept = registry.projects.filter((p) => isAbsolute(p) || resolve(cwd, p) !== dir);
            const projects = kept.includes(dir) ? kept : [...kept, dir];
            return new ShelfRegistry({ ...registry, projects });
          });
        }),

        addManual: Effect.fn("RegistryService.addManual")(function* (alias: string) {
          yield* update((registry) =>
            registry.manual.includes(alias)
              ? registry
              : new ShelfRegistry({ ...registry, manual: [...registry.manual, alias] }),
          );
        }),

        removeManual: Effect.fn("RegistryService.removeManual")(function* (alias: string) {
          yield* update(
            (registry) =>
              new ShelfRegistry({
                ...registry,
                manual: registry.manual.filter((m) => m !== alias),
              }),
          );
        }),

        renameManual: Effect.fn("RegistryService.renameManual")(function* (
          oldAlias: string,
          newAlias: string,
        ) {
          yield* update((registry) =>
            registry.manual.includes(oldAlias)
              ? new ShelfRegistry({
                  ...registry,
                  manual: [
                    ...registry.manual.filter((m) => m !== oldAlias && m !== newAlias),
                    newAlias,
                  ],
                })
              : registry,
          );
        }),

        /**
         * Works out which aliases are referenced: the manual list plus every
         * registered project's shelffile. Reads only; never writes.
         */
        scanReferences: Effect.fn("RegistryService.scanReferences")(function* () {
          const registry = yield* load();
          const aliases = new Set<string>(registry.manual);
          const staleProjects: string[] = [];
          const warnings: string[] = [];
          let anyMightBeReferenced = false;

          for (const projectDir of registry.projects) {
            if (!isAbsolute(projectDir)) {
              // Keep it, and keep every repo, until a re-install replaces it.
              anyMightBeReferenced = true;
              warnings.push(
                `Registry entry "${projectDir}" is a relative path from an older shelf and can't be located. Run \`shelf install --dir ${projectDir}\` from the folder you first ran it in (or delete the entry from registry.json).`,
              );
              continue;
            }
            const state = yield* projectState(fs, projectDir);
            if (state === "missing") {
              staleProjects.push(projectDir);
              continue;
            }
            if (state !== "present") {
              anyMightBeReferenced = true;
              warnings.push(`Can't check project ${projectDir}: ${state.unknown}`);
              continue;
            }

            const shelffilePath = join(projectDir, "shelffile");
            const outcome = yield* shelffile.read(projectDir).pipe(
              Effect.map((sf) => ({ entries: sf.entries })),
              Effect.catchTag("ShelffileNotFoundError", () => Effect.succeed({ entries: [] })),
              Effect.catchTag("ShelffileParseError", (error) =>
                Effect.succeed({ parseError: error.message }),
              ),
            );
            if ("entries" in outcome) {
              for (const entry of outcome.entries) aliases.add(entry.alias);
              continue;
            }

            const possible = yield* shelffile
              .possibleAliases(projectDir)
              .pipe(Effect.orElseSucceed(() => null));
            if (possible === null) {
              anyMightBeReferenced = true;
              warnings.push(
                `Can't read ${shelffilePath} (${outcome.parseError}); keeping every repo.`,
              );
              continue;
            }
            for (const alias of possible) aliases.add(alias);
            warnings.push(
              `Can't parse ${shelffilePath} (${outcome.parseError}); keeping every repo it names.`,
            );
          }

          const scan: ReferenceScan = { aliases, anyMightBeReferenced, staleProjects, warnings };
          return scan;
        }),

        /** Drops the given project folders from the registry. */
        dropProjects: Effect.fn("RegistryService.dropProjects")(function* (
          dirs: ReadonlyArray<string>,
        ) {
          if (dirs.length === 0) return;
          const drop = new Set(dirs);
          yield* update(
            (current) =>
              new ShelfRegistry({
                ...current,
                projects: current.projects.filter((p) => !drop.has(p)),
              }),
          );
        }),
      };
    }),
  },
) {
  static layer = Layer.effect(this, this.make);
}
