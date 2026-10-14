import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import { Argument, Command } from "effect/cli";
import { RepoService } from "../../domain/repo/repo-service";

const oldAlias = Argument.String("old");
const newAlias = Argument.String("new");

export const aliasCommand = Command.make("alias", { oldAlias, newAlias }, (config) =>
  Effect.gen(function* () {
    const repo = yield* RepoService;
    yield* repo.rename(config.oldAlias, config.newAlias);
    yield* Console.log(`Renamed "${config.oldAlias}" → "${config.newAlias}"`);
  }),
).pipe(Command.withDescription("Rename a repo alias"));
