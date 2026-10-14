import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import { Argument, Command } from "effect/cli";
import { RepoService } from "../../domain/repo/repo-service";

const alias = Argument.String("alias").pipe(Argument.optional);

export const updateCommand = Command.make("update", { alias }, (config) =>
	Effect.gen(function* () {
		const repo = yield* RepoService;
		yield* repo.update(config.alias);
		yield* Console.log("Update complete.");
	}),
).pipe(Command.withDescription("Sync one or all repositories"));
