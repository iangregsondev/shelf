import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import { Argument, Command } from "effect/cli";
import { RepoService } from "../../domain/repo/repo-service";
import { describeLastSynced, describePin } from "../../domain/repo/repo-utils";
import { referencesOf } from "../references";
import { RepoNotFoundError } from "../../domain/repo/repo-errors";
import type { RepoEntry } from "../../domain/config/config-schema";

const alias = Argument.String("alias");

export const infoCommand = Command.make("info", { alias }, (config) =>
  Effect.gen(function* () {
    const repo = yield* RepoService;
    const repos = yield* repo.list();
    const entry = (repos as ReadonlyArray<RepoEntry>).find((r) => r.alias === config.alias);
    if (!entry) {
      return yield* new RepoNotFoundError({ alias: config.alias });
    }
    // Scan first, so its warnings come before the repo's details.
    const refs = (yield* referencesOf())(entry.alias);
    const folder = yield* repo.folder(entry.alias);
    const repoDir = folder.path;
    const sizeMb = (folder.sizeBytes / (1024 * 1024)).toFixed(1);
    yield* Console.log(`Alias:       ${entry.alias}`);
    yield* Console.log(`URL:         ${entry.url}`);
    yield* Console.log(`Pin:         ${describePin(entry.pin)}`);
    yield* Console.log(`Added:       ${entry.addedAt}`);
    yield* Console.log(`Last synced: ${describeLastSynced(entry.lastSyncedAt)}`);
    yield* Console.log(`Disk size:   ${sizeMb} MB`);
    yield* Console.log(`Path:        ${repoDir}`);
    if (!folder.exists) {
      yield* Console.log(
        `Folder missing: nothing is at ${repoDir}. Run \`shelf remove ${entry.alias}\` and add it again.`,
      );
    }
    yield* refs === null
      ? Console.log(`Referenced:  unknown (see the warnings above)`)
      : refs.length > 0
        ? Console.log(`Referenced:  ${refs.join(", ")}`)
        : Console.log(`Referenced:  none (candidate for \`shelf prune\`)`);
    // Top-level directory listing, leaving out hidden entries such as .git
    const visible = folder.contents.filter((i) => !i.startsWith("."));
    if (visible.length > 0) {
      yield* Console.log(`\nContents:`);
      for (const item of visible) {
        yield* Console.log(`  ${item}`);
      }
    }
  }),
).pipe(Command.withDescription("Show detailed info for a single repo"));
