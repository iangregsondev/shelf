import { describe, test, expect, afterEach } from "vite-plus/test";
import * as Option from "effect/Option";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSkillDir } from "../../src/cli/commands/init";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";
import { createBareRepo } from "../helpers/temp-repo";
import { writeText } from "../helpers/files";

describe("init command", () => {
	describe("resolveSkillDir", () => {
		test("defaults to .agents/skills/shelf when no agent specified", () => {
			expect(resolveSkillDir(Option.none())).toBe(".agents/skills/shelf");
		});

		test("--agent claude writes to .claude/skills/shelf", () => {
			expect(resolveSkillDir(Option.some("claude"))).toBe(".claude/skills/shelf");
		});

		test("--agent opencode writes to .opencode/skills/shelf", () => {
			expect(resolveSkillDir(Option.some("opencode"))).toBe(".opencode/skills/shelf");
		});

		test("--agent gemini writes to .gemini/skills/shelf", () => {
			expect(resolveSkillDir(Option.some("gemini"))).toBe(".gemini/skills/shelf");
		});

		test("unknown agent falls back to default .agents/skills/shelf", () => {
			expect(resolveSkillDir(Option.some("unknown"))).toBe(".agents/skills/shelf");
		});
	});

	describe("shelf init with detected dependencies", () => {
		let shelf: ShelfSandbox;
		const cleanups: Array<() => Promise<void>> = [];

		afterEach(async () => {
			await shelf.cleanup();
			for (const cleanup of cleanups.splice(0)) await cleanup();
		});

		test("adds detected repos and points at the shelf home's repos folder", async () => {
			// A bare repo whose path ends in .git, so the npm repository URL survives normalisation.
			const bare = await createBareRepo({ "index.ts": "export const fixture = 1;" });
			const remote = `${bare.dir}.git`;
			await rename(bare.dir, remote);
			cleanups.push(() => rm(remote, { recursive: true, force: true }));
			const project = await mkdtemp(join(tmpdir(), "shelf-init-project-"));
			cleanups.push(() => rm(project, { recursive: true, force: true }));
			await writeText(
				join(project, "package.json"),
				JSON.stringify({ dependencies: { "shelf-init-fixture": "^1.0.0" } }),
			);
			shelf = await createShelfSandbox({
				npm: { "shelf-init-fixture": { repository: { type: "git", url: remote } } },
			});

			const result = await shelf.run(["init"], { cwd: project });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('Added "shelf-init-fixture"');
			expect(result.stdout).toContain(
				`Shelf is ready. Your agent can read repos at ${join(shelf.home, "repos")}/`,
			);
			expect(result.stdout).not.toContain("~/.agents/shelf/repos/");
		});
	});
});
