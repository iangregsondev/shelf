import * as Effect from "effect/Effect";
import { layer } from "@effect/platform-node/NodeServices";
import { runGit as spawnGit } from "../../src/domain/git/git-utils";

/** Effect's platform services (file system, child processes) for tests on real service layers. */
export const PlatformLayer = layer;

/** `runGit` with the platform services provided. */
export const runGit = (args: ReadonlyArray<string>, cwd?: string | undefined) =>
	spawnGit(args, cwd).pipe(Effect.provide(PlatformLayer));
