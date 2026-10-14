import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { ConfigService } from "../config/config-service";
import { errorCode } from "../config/config-utils";
import { ShelffileService } from "../shelffile/shelffile-service";
import { ShelfRegistry, defaultRegistry, decodeRegistry, encodeRegistry } from "./registry-schema";
import { RegistryParseError } from "./registry-errors";
import { possibleShelffileAliases } from "../shelffile/shelffile-utils";
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
	 * Registry entries to drop: the folder no longer exists, or the path is
	 * relative (recorded by an older shelf) so it can't be located.
	 */
	readonly staleProjects: ReadonlyArray<string>;
	/** Problems reading projects, one line each. */
	readonly warnings: ReadonlyArray<string>;
}

type ProjectState = "present" | "missing" | { readonly unknown: string };

/** "missing" only when the folder is definitely gone. */
const projectState = async (dir: string): Promise<ProjectState> => {
	try {
		await stat(dir);
		return "present";
	} catch (error) {
		const code = errorCode(error);
		if (code === "ENOENT" || code === "ENOTDIR") return "missing";
		return { unknown: error instanceof Error ? error.message : String(error) };
	}
};

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
							staleProjects.push(projectDir);
							anyMightBeReferenced = true;
							warnings.push(
								`Registry entry "${projectDir}" is a relative path from an older shelf and can't be located; prune drops it. Run \`shelf install\` in that project again to keep its repos.`,
							);
							continue;
						}
						const state = yield* Effect.promise(() => projectState(projectDir));
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

						const content = yield* Effect.promise(() =>
							Bun.file(shelffilePath)
								.text()
								.catch(() => null),
						);
						if (content === null) {
							anyMightBeReferenced = true;
							warnings.push(
								`Can't read ${shelffilePath} (${outcome.parseError}); keeping every repo.`,
							);
							continue;
						}
						for (const alias of possibleShelffileAliases(content)) aliases.add(alias);
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
