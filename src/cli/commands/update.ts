import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import { Argument, Command } from "effect/cli";
import { RepoService } from "../../domain/repo/repo-service";
import { SyncFailedError } from "../../domain/sync/sync-errors";
import { formatUserError } from "../error-handler";
import { GitOperationError } from "../../domain/git/git-errors";
import { gitErrorLine } from "../../domain/git/git-utils";

const alias = Argument.String("alias").pipe(Argument.optional);

export const updateCommand = Command.make("update", { alias }, (config) =>
  Effect.gen(function* () {
    const repo = yield* RepoService;
    const { total, failures } = yield* repo.sync(config.alias);
    if (failures.length > 0) {
      for (const failure of failures) {
        // Git's stderr runs to several lines; one is enough to say why.
        const error =
          failure.error._tag === "GitOperationError"
            ? new GitOperationError({
                command: failure.error.command,
                message: gitErrorLine(failure.error.message),
              })
            : failure.error;
        const reason = formatUserError(error) ?? String(error);
        yield* Console.error(`  "${failure.alias}" failed: ${reason}`);
      }
      return yield* new SyncFailedError({ failed: failures.length, total });
    }
    yield* Console.log("Update complete.");
  }),
).pipe(Command.withDescription("Sync one or all repositories"));
