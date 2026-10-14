import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import { Command } from "effect/cli";
import { RepoService } from "../../domain/repo/repo-service";
import { describeLastSynced, describePin } from "../../domain/repo/repo-utils";
import { ConfigService } from "../../domain/config/config-service";
import type { RepoEntry } from "../../domain/config/config-schema";

export const listCommand = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const repo = yield* RepoService;
    const config = yield* ConfigService;
    const repos = yield* repo.list();
    if (repos.length === 0) {
      yield* Console.log("No repos configured. Use `shelf add <url>` to add one.");
      return;
    }
    for (const r of repos as ReadonlyArray<RepoEntry>) {
      yield* Console.log(
        `  ${r.alias} — ${r.url} [${describePin(r.pin)}] (synced: ${describeLastSynced(r.lastSyncedAt)})`,
      );
      const path = yield* config
        .repoPath(r.alias)
        .pipe(Effect.orElseSucceed(() => "(invalid alias: rename it in config.json)"));
      yield* Console.log(`    → ${path}`);
    }
  }),
).pipe(Command.withDescription("List all configured repositories"));
