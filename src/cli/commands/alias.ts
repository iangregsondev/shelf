import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import { Argument, Command } from "effect/cli";
import { ConfigService } from "../../domain/config/config-service";
import { RegistryService } from "../../domain/registry/registry-service";
import { RepoNotFoundError, RepoAlreadyExistsError } from "../../domain/repo/repo-errors";
import { RepoEntry, ShelfConfig } from "../../domain/config/config-schema";

const oldAlias = Argument.String("old");
const newAlias = Argument.String("new");

export const aliasCommand = Command.make("alias", { oldAlias, newAlias }, (config) =>
	Effect.gen(function* () {
		const configService = yield* ConfigService;
		const registry = yield* RegistryService;
		const cfg = yield* configService.load();
		const repo = cfg.repos.find((r: RepoEntry) => r.alias === config.oldAlias);
		if (!repo) {
			return yield* new RepoNotFoundError({ alias: config.oldAlias });
		}
		const conflict = cfg.repos.find((r: RepoEntry) => r.alias === config.newAlias);
		if (conflict) {
			return yield* new RepoAlreadyExistsError({ alias: config.newAlias });
		}
		// Rename directory on disk
		const oldPath = configService.repoPath(config.oldAlias);
		const newPath = configService.repoPath(config.newAlias);
		yield* Effect.tryPromise({
			try: async () => {
				const { rename } = await import("node:fs/promises");
				await rename(oldPath, newPath);
			},
			catch: () => undefined,
		}).pipe(Effect.ignore);
		// Update config
		yield* configService.update(
			(current) =>
				new ShelfConfig({
					...current,
					repos: current.repos.map((r: RepoEntry) =>
						r.alias === config.oldAlias ? new RepoEntry({ ...r, alias: config.newAlias }) : r,
					),
				}),
		);
		// Update registry manual list
		yield* registry.renameManual(config.oldAlias, config.newAlias);
		yield* Console.log(`Renamed "${config.oldAlias}" → "${config.newAlias}"`);
	}),
).pipe(Command.withDescription("Rename a repo alias"));
