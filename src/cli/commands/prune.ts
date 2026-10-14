import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import { Command, Flag } from "effect/cli";
import { ConfigService } from "../../domain/config/config-service";
import { RepoService } from "../../domain/repo/repo-service";
import { RegistryService, type ReferenceScan } from "../../domain/registry/registry-service";
import type { RepoEntry } from "../../domain/config/config-schema";
import { trashLeftWarning } from "../warnings";

const dryRun = Flag.Boolean("dry-run").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Show what would be removed without removing"),
);
const force = Flag.Boolean("force").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Actually remove unreferenced repos"),
);

/** Lists the unreferenced repos, and with --force removes them. */
const pruneRepos = (
  options: { readonly dryRun: boolean; readonly force: boolean },
  scan: ReferenceScan,
) =>
  Effect.gen(function* () {
    const repo = yield* RepoService;
    const configService = yield* ConfigService;
    if (scan.anyMightBeReferenced) {
      yield* Console.log("Not removing any repos: fix the problems above, then prune again.");
      return;
    }
    const cfg = yield* configService.load();
    const unreferenced = cfg.repos.filter((r: RepoEntry) => !scan.aliases.has(r.alias));
    if (unreferenced.length === 0) {
      yield* Console.log("No unreferenced repos found.");
      return;
    }
    yield* Console.log(`Found ${unreferenced.length} unreferenced repo(s):`);
    for (const r of unreferenced) {
      yield* Console.log(`  ${r.alias} — ${r.url}`);
    }
    if (options.dryRun) {
      return;
    }
    if (!options.force) {
      yield* Console.log("\nUse --force to remove these repos.");
      return;
    }
    // Each remove's trash is left to the clear at the end, which reports it once.
    for (const r of unreferenced) {
      yield* repo.remove(r.alias);
      yield* Console.log(`  Removed "${r.alias}"`);
    }
    yield* Console.log(`\nPruned ${unreferenced.length} repo(s).`);
  });

export const pruneCommand = Command.make("prune", { dryRun, force }, (config) =>
  Effect.gen(function* () {
    const registry = yield* RegistryService;
    const repo = yield* RepoService;
    const scan = yield* registry.scanReferences();
    if (!config.dryRun) {
      yield* registry.dropProjects(scan.staleProjects);
    }
    for (const dir of scan.staleProjects) {
      yield* Console.log(
        `${config.dryRun ? "Would drop" : "Dropped"} stale project from the registry: ${dir}`,
      );
    }
    for (const warning of scan.warnings) {
      yield* Console.error(`Warning: ${warning}`);
    }
    yield* pruneRepos(config, scan);
    if (!config.dryRun) {
      // Trash is what a remove couldn't finish deleting, this run's or an
      // earlier one's: always safe to clear.
      for (const trash of yield* repo.clearTrash()) {
        yield* Console.error(trashLeftWarning(trash));
      }
    }
  }),
).pipe(Command.withDescription("Remove unreferenced repos"));
