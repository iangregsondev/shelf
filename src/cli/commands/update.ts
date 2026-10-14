import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import { Argument, Command } from "effect/cli";
import { RepoService } from "../../domain/repo/repo-service";
import { SyncFailedError } from "../../domain/sync/sync-errors";
import { formatUserError } from "../error-handler";

const alias = Argument.String("alias").pipe(Argument.optional);

export const updateCommand = Command.make("update", { alias }, (config) =>
	Effect.gen(function* () {
		const repo = yield* RepoService;
		const { total, failures } = yield* repo.sync(config.alias);
		if (failures.length > 0) {
			for (const failure of failures) {
				const reason = formatUserError(failure.error) ?? String(failure.error);
				yield* Console.error(`  "${failure.alias}" failed: ${reason}`);
			}
			return yield* new SyncFailedError({ failed: failures.length, total });
		}
		yield* Console.log("Update complete.");
	}),
).pipe(Command.withDescription("Sync one or all repositories"));
