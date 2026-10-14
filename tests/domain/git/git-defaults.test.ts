import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitService } from "../../../src/domain/git/git-service";
import { PlatformLayer, runGit } from "../../helpers/platform";
import { createTempRepo } from "../../helpers/temp-repo";
import { writeText } from "../../helpers/files";
import { run } from "../../helpers/process";
import { existsSync } from "node:fs";

describe("GitService default clone behavior", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "shelf-git-defaults-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("clone defaults to depth 1 (shallow)", async () => {
		// Need file:// protocol for depth to work with local repos
		const sourceRepo = await createTempRepo({ "test.txt": "hello" });
		await writeText(join(sourceRepo.dir, "test.txt"), "updated");
		await run(["git", "add", "."], { cwd: sourceRepo.dir });
		await run(["git", "commit", "-m", "second"], { cwd: sourceRepo.dir });
		const bareDir = await mkdtemp(join(tmpdir(), "shelf-bare-defaults-"));
		await rm(bareDir, { recursive: true, force: true });
		await run(["git", "clone", "--bare", sourceRepo.dir, bareDir]);

		const targetDir = join(tempDir, "default-depth");
		await Effect.runPromise(
			Effect.gen(function* () {
				const git = yield* GitService;
				yield* git.clone(
					`file://${bareDir}`,
					targetDir,
					Option.none(), // no pin
					Option.none(), // no explicit depth — should default to 1
					Option.none(), // no sparse
				);
			}).pipe(Effect.provide(GitService.layer), Effect.provide(PlatformLayer)),
		);

		// Should be a shallow clone
		expect(existsSync(join(targetDir, ".git", "shallow"))).toBe(true);
		expect(existsSync(join(targetDir, "test.txt"))).toBe(true);

		await sourceRepo.cleanup();
		await rm(bareDir, { recursive: true, force: true });
	});

	test("clone with --single-branch only fetches one branch", async () => {
		const sourceRepo = await createTempRepo({ "test.txt": "main" });
		// Create a second branch
		await run(["git", "checkout", "-b", "feature"], { cwd: sourceRepo.dir });
		await writeText(join(sourceRepo.dir, "test.txt"), "feature");
		await run(["git", "add", "."], { cwd: sourceRepo.dir });
		await run(["git", "commit", "-m", "feature"], { cwd: sourceRepo.dir });
		await run(["git", "checkout", "-"], { cwd: sourceRepo.dir });

		const bareDir = await mkdtemp(join(tmpdir(), "shelf-bare-single-"));
		await rm(bareDir, { recursive: true, force: true });
		await run(["git", "clone", "--bare", sourceRepo.dir, bareDir]);

		const targetDir = join(tempDir, "single-branch");
		await Effect.runPromise(
			Effect.gen(function* () {
				const git = yield* GitService;
				yield* git.clone(
					`file://${bareDir}`,
					targetDir,
					Option.none(),
					Option.none(),
					Option.none(),
				);
			}).pipe(Effect.provide(GitService.layer), Effect.provide(PlatformLayer)),
		);

		// With --single-branch, remote tracking branches should be limited
		const branches = await Effect.runPromise(runGit(["branch", "-r"], targetDir));
		// Should not have the 'feature' branch tracked
		expect(branches).not.toContain("origin/feature");

		await sourceRepo.cleanup();
		await rm(bareDir, { recursive: true, force: true });
	});

	test("explicit depth overrides the default", async () => {
		const sourceRepo = await createTempRepo({ "test.txt": "hello" });
		await writeText(join(sourceRepo.dir, "test.txt"), "updated");
		await run(["git", "add", "."], { cwd: sourceRepo.dir });
		await run(["git", "commit", "-m", "second"], { cwd: sourceRepo.dir });
		await writeText(join(sourceRepo.dir, "test.txt"), "third");
		await run(["git", "add", "."], { cwd: sourceRepo.dir });
		await run(["git", "commit", "-m", "third"], { cwd: sourceRepo.dir });

		const bareDir = await mkdtemp(join(tmpdir(), "shelf-bare-explicit-"));
		await rm(bareDir, { recursive: true, force: true });
		await run(["git", "clone", "--bare", sourceRepo.dir, bareDir]);

		const targetDir = join(tempDir, "explicit-depth");
		await Effect.runPromise(
			Effect.gen(function* () {
				const git = yield* GitService;
				yield* git.clone(
					`file://${bareDir}`,
					targetDir,
					Option.none(),
					Option.some(2), // explicit depth 2
					Option.none(),
				);
			}).pipe(Effect.provide(GitService.layer), Effect.provide(PlatformLayer)),
		);

		expect(existsSync(join(targetDir, ".git", "shallow"))).toBe(true);
		expect(existsSync(join(targetDir, "test.txt"))).toBe(true);

		await sourceRepo.cleanup();
		await rm(bareDir, { recursive: true, force: true });
	});
});
