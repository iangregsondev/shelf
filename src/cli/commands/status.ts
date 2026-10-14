import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import { Command } from "effect/cli";
import { RepoService } from "../../domain/repo/repo-service";
import { describeLastSynced, describePin } from "../../domain/repo/repo-utils";
import { referencesOf } from "../references";
import type { RepoEntry } from "../../domain/config/config-schema";

export const statusCommand = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const repo = yield* RepoService;
    const repos = yield* repo.list();
    if (repos.length === 0) {
      yield* Console.log("No repos configured. Use `shelf add <url>` to add one.");
      return;
    }
    const references = yield* referencesOf();
    for (const r of repos as ReadonlyArray<RepoEntry>) {
      const size = yield* repo.size(r.alias).pipe(
        Effect.map((bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`),
        Effect.orElseSucceed(() => "(invalid alias: rename it in config.json)"),
      );
      yield* Console.log(`  ${r.alias} — ${r.url}`);
      yield* Console.log(
        `    Pin: ${describePin(r.pin)}  |  Synced: ${describeLastSynced(r.lastSyncedAt)}  |  Size: ${size}`,
      );
      const refs = references(r.alias);
      yield* refs === null
        ? Console.log(`    Referenced by: unknown (see the warnings above)`)
        : refs.length > 0
          ? Console.log(`    Referenced by: ${refs.join(", ")}`)
          : Console.log(`    ⚠ Unreferenced (candidate for \`shelf prune\`)`);
    }
  }),
).pipe(Command.withDescription("Show detailed status of all repos"));
