import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import { Argument, Command } from "effect/cli";
import { RepoService } from "../../domain/repo/repo-service";

const alias = Argument.String("alias");
const ref = Argument.String("ref");

export const pinCommand = Command.make("pin", { alias, ref }, (config) =>
	Effect.gen(function* () {
		const repo = yield* RepoService;
		const pin = yield* repo.pin(config.alias, config.ref);
		yield* Console.log(`Pinned "${config.alias}" to ${pin.type}:${pin.value}`);
	}),
).pipe(
	Command.withDescription(
		"Pin a repo to branch:<name>, tag:<name>, commit:<hash>, or a bare tag or branch name",
	),
);
