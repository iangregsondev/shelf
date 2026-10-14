import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import { Argument, Command } from "effect/cli";
import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { ConfigService } from "../../domain/config/config-service";
import { RegistryService } from "../../domain/registry/registry-service";
import {
	AliasRenameError,
	RepoNotFoundError,
	RepoAlreadyExistsError,
} from "../../domain/repo/repo-errors";
import { checkAlias } from "../../domain/repo/repo-utils";
import { RepoEntry, ShelfConfig } from "../../domain/config/config-schema";

const oldAlias = Argument.String("old");
const newAlias = Argument.String("new");

export const aliasCommand = Command.make("alias", { oldAlias, newAlias }, (config) =>
	Effect.gen(function* () {
		const configService = yield* ConfigService;
		const registry = yield* RegistryService;
		const from = config.oldAlias;
		const to = yield* checkAlias(config.newAlias);
		const cfg = yield* configService.load();
		if (!cfg.repos.some((r: RepoEntry) => r.alias === from)) {
			return yield* new RepoNotFoundError({ alias: from });
		}
		if (cfg.repos.some((r: RepoEntry) => r.alias === to)) {
			return yield* new RepoAlreadyExistsError({ alias: to });
		}
		const oldPath = configService.repoPath(from);
		const newPath = configService.repoPath(to);
		// rename() silently replaces an empty folder, so refuse any folder already there.
		if (existsSync(newPath)) {
			return yield* new AliasRenameError({
				from,
				to,
				message: `a folder already exists at ${newPath}`,
			});
		}
		yield* Effect.tryPromise({
			try: () => rename(oldPath, newPath),
			catch: (error) =>
				new AliasRenameError({
					from,
					to,
					message: error instanceof Error ? error.message : String(error),
				}),
		});
		// Move the folder back if the config can't follow, so the two never disagree.
		yield* configService
			.update((current) =>
				current.repos.some((r: RepoEntry) => r.alias === to)
					? Effect.fail(new RepoAlreadyExistsError({ alias: to }))
					: Effect.succeed(
							new ShelfConfig({
								...current,
								repos: current.repos.map((r: RepoEntry) =>
									r.alias === from ? new RepoEntry({ ...r, alias: to }) : r,
								),
							}),
						),
			)
			.pipe(
				Effect.onError(() => Effect.tryPromise(() => rename(newPath, oldPath)).pipe(Effect.ignore)),
			);
		yield* registry.renameManual(from, to);
		yield* Console.log(`Renamed "${from}" → "${to}"`);
	}),
).pipe(Command.withDescription("Rename a repo alias"));
