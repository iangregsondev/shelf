import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import { join } from "node:path";
import { ConfigService } from "../config/config-service";
import { ShelffileService } from "../shelffile/shelffile-service";
import { ShelfRegistry, defaultRegistry, decodeRegistry, encodeRegistry } from "./registry-schema";
import { RegistryParseError } from "./registry-errors";
import { withStateFileLock, writeFileAtomic } from "../config/state-file-utils";

const REGISTRY_FILE = "registry.json";

export class RegistryService extends Context.Service<RegistryService>()(
	"shelf/domain/registry/RegistryService",
	{
		make: Effect.gen(function* () {
			const config = yield* ConfigService;
			const shelffile = yield* ShelffileService;

			const registryPath = join(config.configDir, REGISTRY_FILE);

			const load = Effect.fn("RegistryService.load")(function* () {
				const file = Bun.file(registryPath);
				const exists = yield* Effect.tryPromise({
					try: () => file.exists(),
					catch: () => new RegistryParseError({ message: "Failed to check registry file" }),
				});
				if (!exists) {
					return defaultRegistry;
				}
				const raw = yield* Effect.tryPromise({
					try: () => file.json(),
					catch: () => new RegistryParseError({ message: "Failed to read registry file" }),
				});
				return yield* Effect.try({
					try: () => decodeRegistry(raw),
					catch: () => new RegistryParseError({ message: "Invalid registry schema" }),
				});
			});

			const save = (registry: ShelfRegistry): Effect.Effect<void, RegistryParseError> =>
				Effect.tryPromise({
					try: () =>
						writeFileAtomic(registryPath, JSON.stringify(encodeRegistry(registry), null, "\t")),
					catch: () => new RegistryParseError({ message: "Failed to write registry file" }),
				});

			/**
			 * Reads the registry, applies `fn` and saves the result, holding the
			 * in-process and cross-process registry locks throughout. Returns the
			 * saved registry.
			 */
			const update = (
				fn: (current: ShelfRegistry) => ShelfRegistry,
			): Effect.Effect<ShelfRegistry, RegistryParseError> =>
				Effect.gen(function* () {
					const next = fn(yield* load());
					yield* save(next);
					return next;
				}).pipe(
					withStateFileLock(registryPath, (message) => new RegistryParseError({ message })),
					Effect.withSpan("RegistryService.update"),
				);

			return {
				load,
				update,

				registerProject: Effect.fn("RegistryService.registerProject")(function* (dir: string) {
					yield* update((registry) =>
						registry.projects.includes(dir)
							? registry
							: new ShelfRegistry({ ...registry, projects: [...registry.projects, dir] }),
					);
				}),

				unregisterProject: Effect.fn("RegistryService.unregisterProject")(function* (dir: string) {
					yield* update(
						(registry) =>
							new ShelfRegistry({
								...registry,
								projects: registry.projects.filter((p) => p !== dir),
							}),
					);
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

				getReferencedAliases: Effect.fn("RegistryService.getReferencedAliases")(function* () {
					const registry = yield* load();
					const aliases = new Set<string>(registry.manual);
					const validProjects: string[] = [];

					for (const projectDir of registry.projects) {
						const dirExists = yield* Effect.tryPromise({
							try: async () => {
								const { stat } = await import("node:fs/promises");
								await stat(projectDir);
								return true;
							},
							catch: () => false,
						});
						if (!dirExists) continue;
						validProjects.push(projectDir);

						const sf = yield* shelffile
							.read(projectDir)
							.pipe(Effect.catch(() => Effect.succeed(null)));
						if (sf === null) continue;
						for (const entry of sf.entries) {
							aliases.add(entry.alias);
						}
					}

					// Clean stale project paths
					if (validProjects.length !== registry.projects.length) {
						const stale = new Set(registry.projects.filter((p) => !validProjects.includes(p)));
						yield* update(
							(current) =>
								new ShelfRegistry({
									...current,
									projects: current.projects.filter((p) => !stale.has(p)),
								}),
						);
					}

					return aliases;
				}),
			};
		}),
	},
) {
	static layer = Layer.effect(this, this.make);
}
