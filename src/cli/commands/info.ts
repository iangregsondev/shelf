import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import * as Option from "effect/Option";
import { Argument, Command } from "effect/cli";
import { RepoService } from "../../domain/repo/repo-service";
import { RegistryService } from "../../domain/registry/registry-service";
import { ShelffileService } from "../../domain/shelffile/shelffile-service";
import { RepoNotFoundError } from "../../domain/repo/repo-errors";
import type { RepoEntry } from "../../domain/config/config-schema";

const alias = Argument.String("alias");

export const infoCommand = Command.make("info", { alias }, (config) =>
	Effect.gen(function* () {
		const repo = yield* RepoService;
		const registry = yield* RegistryService;
		const shelffileService = yield* ShelffileService;
		const repos = yield* repo.list();
		const entry = (repos as ReadonlyArray<RepoEntry>).find((r) => r.alias === config.alias);
		if (!entry) {
			return yield* new RepoNotFoundError({ alias: config.alias });
		}
		const folder = yield* repo.folder(entry.alias);
		const repoDir = folder.path;
		const pinStr = Option.match(entry.pin, {
			onNone: () => "(default branch)",
			onSome: (p) => `${p.type}:${p.value}`,
		});
		const syncStr = Option.match(entry.lastSyncedAt, {
			onNone: () => "never",
			onSome: (s: string) => s,
		});
		const sizeMb = (folder.sizeBytes / (1024 * 1024)).toFixed(1);
		yield* Console.log(`Alias:       ${entry.alias}`);
		yield* Console.log(`URL:         ${entry.url}`);
		yield* Console.log(`Pin:         ${pinStr}`);
		yield* Console.log(`Added:       ${entry.addedAt}`);
		yield* Console.log(`Last synced: ${syncStr}`);
		yield* Console.log(`Disk size:   ${sizeMb} MB`);
		yield* Console.log(`Path:        ${repoDir}`);
		if (!folder.exists) {
			yield* Console.log(
				`Folder missing: nothing is at ${repoDir}. Run \`shelf remove ${entry.alias}\` and add it again.`,
			);
		}
		// Show references
		const reg = yield* registry.load();
		const refs: string[] = [];
		if (reg.manual.includes(entry.alias)) refs.push("manual");
		for (const projectDir of reg.projects) {
			const sf = yield* shelffileService
				.read(projectDir)
				.pipe(Effect.catch(() => Effect.succeed(null)));
			if (sf === null) continue;
			if (sf.entries.some((e) => e.alias === entry.alias)) {
				refs.push(projectDir);
			}
		}
		yield* refs.length > 0
			? Console.log(`Referenced:  ${refs.join(", ")}`)
			: Console.log(`Referenced:  none (candidate for \`shelf prune\`)`);
		// Top-level directory listing
		if (folder.contents.length > 0) {
			yield* Console.log(`\nContents:`);
			for (const item of folder.contents.filter((i) => !i.startsWith("."))) {
				yield* Console.log(`  ${item}`);
			}
		}
	}),
).pipe(Command.withDescription("Show detailed info for a single repo"));
