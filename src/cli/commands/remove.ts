import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import { Argument, Command } from "effect/cli";
import { RepoService } from "../../domain/repo/repo-service";
import { RegistryService } from "../../domain/registry/registry-service";
import { trashLeftWarning } from "../error-handler";

const aliasOrUrl = Argument.String("alias-or-url");

export const removeCommand = Command.make("remove", { aliasOrUrl }, (config) =>
  Effect.gen(function* () {
    const repo = yield* RepoService;
    const registry = yield* RegistryService;
    const removed = yield* repo.remove(config.aliasOrUrl);
    yield* registry.removeManual(removed.alias);
    yield* Console.log(
      removed.orphan
        ? `Removed orphan folder for "${removed.alias}" (it had no config entry).`
        : `Removed repo "${removed.alias}"`,
    );
    for (const trash of removed.trashLeft) {
      yield* Console.error(trashLeftWarning(trash));
    }
  }),
).pipe(Command.withDescription("Remove a repository from shelf"));
