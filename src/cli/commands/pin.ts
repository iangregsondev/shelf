import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import * as Option from "effect/Option";
import { Argument, Command } from "effect/cli";
import { ConfigService } from "../../domain/config/config-service";
import { SyncService } from "../../domain/sync/sync-service";
import { RepoNotFoundError } from "../../domain/repo/repo-errors";
import { RepoEntry, ShelfConfig } from "../../domain/config/config-schema";
import { parsePin } from "../../domain/repo/repo-utils";

const alias = Argument.String("alias");
const ref = Argument.String("ref");

export const pinCommand = Command.make("pin", { alias, ref }, (config) =>
	Effect.gen(function* () {
		const configService = yield* ConfigService;
		const sync = yield* SyncService;
		const newPin = parsePin(config.ref);
		const updated = yield* configService.update((cfg) =>
			cfg.repos.some((r: RepoEntry) => r.alias === config.alias)
				? Effect.succeed(
						new ShelfConfig({
							...cfg,
							repos: cfg.repos.map((r: RepoEntry) =>
								r.alias === config.alias ? new RepoEntry({ ...r, pin: Option.some(newPin) }) : r,
							),
						}),
					)
				: Effect.fail(new RepoNotFoundError({ alias: config.alias })),
		);
		const updatedRepo = updated.repos.find((r: RepoEntry) => r.alias === config.alias);
		if (updatedRepo) yield* sync.syncRepo(updatedRepo);
		yield* Console.log(`Pinned "${config.alias}" to ${newPin.type}:${newPin.value}`);
	}),
).pipe(Command.withDescription("Pin a repo to a specific branch, tag, or commit"));
