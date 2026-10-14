import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import * as Option from "effect/Option";
import { resolve } from "node:path";
import { Command, Flag } from "effect/cli";
import { RepoService } from "../../domain/repo/repo-service";
import { ShelffileService } from "../../domain/shelffile/shelffile-service";
import { RegistryService } from "../../domain/registry/registry-service";
import type { ShelffileEntry } from "../../domain/shelffile/shelffile-schema";
import { InstallFailedError } from "../../domain/shelffile/shelffile-errors";
import type { RepoEntry, RepoPin } from "../../domain/config/config-schema";
import { describePin } from "../../domain/repo/repo-utils";
import { normalizeGitUrl } from "../../domain/detect/detect-utils";

// A stored commit pin is the full hash; the shelffile may give a short one.
const samePin = (stored: Option.Option<RepoPin>, wanted: Option.Option<RepoPin>): boolean => {
  if (Option.isNone(stored) || Option.isNone(wanted)) {
    return Option.isNone(stored) && Option.isNone(wanted);
  }
  const s = stored.value;
  const w = wanted.value;
  if (s.type !== w.type) return false;
  return s.type === "commit" ? s.value.startsWith(w.value) : s.value === w.value;
};

/** Where a stored repo differs from its shelffile entry, one line per field. */
const differences = (stored: RepoEntry, entry: ShelffileEntry): ReadonlyArray<string> => {
  const lines: string[] = [];
  if (normalizeGitUrl(stored.url) !== normalizeGitUrl(entry.url)) {
    lines.push(`URL is "${stored.url}" on the shelf but "${entry.url}" in the shelffile`);
  }
  if (!samePin(stored.pin, entry.pin)) {
    lines.push(
      `pin is ${describePin(stored.pin)} on the shelf but ${describePin(entry.pin)} in the shelffile`,
    );
  }
  return lines;
};

const dir = Flag.String("dir").pipe(
  Flag.optional,
  Flag.withDescription("Directory containing the shelffile (defaults to cwd)"),
);

const concurrency = Flag.Int("concurrency").pipe(
  Flag.withDefault(4),
  Flag.withDescription("Number of repos to clone in parallel (default: 4)"),
);

export const installCommand = Command.make("install", { dir, concurrency }, (config) =>
  Effect.gen(function* () {
    const repo = yield* RepoService;
    const shelffileService = yield* ShelffileService;
    const registry = yield* RegistryService;
    const targetDir = resolve(Option.getOrElse(config.dir, () => process.cwd()));
    const shelffile = yield* shelffileService.read(targetDir);
    const entries = shelffile.entries as ReadonlyArray<ShelffileEntry>;

    if (entries.length === 0) {
      yield* Console.log("No repos in shelffile.");
      return;
    }

    yield* Console.log(
      `Installing ${entries.length} repo(s) (concurrency: ${config.concurrency})...`,
    );

    const results = yield* Effect.forEach(
      entries,
      (entry) =>
        repo.add({ url: entry.url, alias: Option.some(entry.alias), pin: entry.pin }).pipe(
          Effect.map(() => ({ alias: entry.alias, status: "added" as const })),
          Effect.catchTag("RepoAlreadyExistsError", () =>
            Effect.gen(function* () {
              // Never overwrite the stored repo; only say where it differs.
              const stored = (yield* repo.list()).find((r) => r.alias === entry.alias);
              for (const line of stored === undefined ? [] : differences(stored, entry)) {
                yield* Console.error(
                  `  Warning: "${entry.alias}" already exists and was left as is: ${line}`,
                );
              }
              return { alias: entry.alias, status: "existing" as const };
            }),
          ),
          Effect.catchTag("GitOperationError", (error) =>
            Effect.gen(function* () {
              yield* Console.error(`  Warning: failed to add "${entry.alias}": ${error.message}`);
              return { alias: entry.alias, status: "failed" as const };
            }),
          ),
        ),
      { concurrency: config.concurrency },
    );

    let added = 0;
    let existing = 0;
    let failed = 0;
    for (const result of results) {
      if (result.status === "added") {
        added++;
        yield* Console.log(`  Added "${result.alias}"`);
      } else if (result.status === "existing") {
        existing++;
      } else {
        failed++;
      }
    }

    yield* registry.registerProject(targetDir);
    yield* Console.log(
      `\nInstall complete: ${added} added, ${existing} already present${failed > 0 ? `, ${failed} failed` : ""}`,
    );
    if (failed > 0) {
      return yield* new InstallFailedError({ failed, total: entries.length });
    }
  }),
).pipe(Command.withDescription("Install repos from a shelffile"));
