import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";
import { createBareRepo } from "../helpers/temp-repo";
import { readText, writeText } from "../helpers/files";
import { skillTemplate } from "../../src/domain/skill/skill-template";

describe("init command", () => {
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

describe("shelf init skill file", () => {
  let shelf: ShelfSandbox;
  let project: string;

  beforeEach(async () => {
    shelf = await createShelfSandbox();
    // Real path: the CLI sees its working directory with symlinks (macOS /var) resolved.
    project = await realpath(await mkdtemp(join(tmpdir(), "shelf-init-skill-")));
  });

  afterEach(async () => {
    await shelf.cleanup();
    await rm(project, { recursive: true, force: true });
  });

  const expectSkillAt = async (stdout: string, relativeDir: string) => {
    const skillPath = join(project, relativeDir, "SKILL.md");
    expect(stdout).toContain(`Created ${skillPath}`);
    expect(await readText(skillPath)).toBe(skillTemplate(join(shelf.home, "repos")));
  };

  test("with no flags writes the universal skill and reports no repos to add", async () => {
    const result = await shelf.run(["init"], { cwd: project });
    expect(result.exitCode).toBe(0);
    await expectSkillAt(result.stdout, ".agents/skills/shelf");
    expect(result.stdout).toContain("No new repos detected from project dependencies.");
  });

  test.each([
    ["claude", ".claude/skills/shelf"],
    ["opencode", ".opencode/skills/shelf"],
    ["gemini", ".gemini/skills/shelf"],
  ])("--agent %s writes the skill to %s", async (agent, dir) => {
    const result = await shelf.run(["init", "--agent", agent, "--no-detect"], { cwd: project });
    expect(result.exitCode).toBe(0);
    await expectSkillAt(result.stdout, dir);
    expect(existsSync(join(project, ".agents"))).toBe(false);
  });

  test.each(["codex", "claud", "toString"])(
    "an unknown --agent %s fails before writing or detecting anything",
    async (agent) => {
      await writeText(
        join(project, "package.json"),
        JSON.stringify({ dependencies: { "shelf-init-fixture": "^1.0.0" } }),
      );
      const result = await shelf.run(["init", "--agent", agent], { cwd: project });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        `Unknown agent "${agent}". Expected one of: claude, opencode, gemini`,
      );
      expect(result.stdout).not.toContain("Created");
      expect(result.stdout).not.toContain("Detected");
      expect(await readdir(project)).toEqual(["package.json"]);
    },
  );

  test("a skill file it can't write fails with one clear line, not a stack trace", async () => {
    // A file stands where the .agents folder should be.
    await writeText(join(project, ".agents"), "");
    const result = await shelf.run(["init", "--no-detect"], { cwd: project });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      `Could not write the skill file ${join(project, ".agents/skills/shelf/SKILL.md")}`,
    );
    expect(result.stderr).not.toMatch(/^\s+at /m);
  });

  test("the skill names the SHELF_HOME repos folder", async () => {
    const result = await shelf.run(["init", "--no-detect"], { cwd: project });
    expect(result.exitCode).toBe(0);
    const text = await readText(join(project, ".agents/skills/shelf/SKILL.md"));
    expect(text).toContain(`\`${join(shelf.home, "repos")}/{alias}/\``);
    expect(text).not.toContain("~/.agents/shelf/repos");
  });

  test("with the default shelf home the skill names ~/.agents/shelf/repos", async () => {
    const userHome = await realpath(await mkdtemp(join(tmpdir(), "shelf-init-user-home-")));
    // An empty SHELF_HOME means the default: <home>/.agents/shelf.
    const defaultShelf = await createShelfSandbox({}, { HOME: userHome, SHELF_HOME: "" });
    try {
      const result = await defaultShelf.run(["init", "--no-detect"], { cwd: project });
      expect(result.exitCode).toBe(0);
      const text = await readText(join(project, ".agents/skills/shelf/SKILL.md"));
      expect(text).toBe(skillTemplate("~/.agents/shelf/repos"));
      expect(text).not.toContain(userHome);
    } finally {
      await defaultShelf.cleanup();
      await rm(userHome, { recursive: true, force: true });
    }
  });

  test("--no-detect writes the skill and skips detection", async () => {
    await writeText(
      join(project, "package.json"),
      JSON.stringify({ dependencies: { "shelf-init-fixture": "^1.0.0" } }),
    );
    const result = await shelf.run(["init", "--no-detect"], { cwd: project });
    expect(result.exitCode).toBe(0);
    await expectSkillAt(result.stdout, ".agents/skills/shelf");
    expect(result.stdout).not.toContain("detected");
    expect(result.stdout).not.toContain("Detected");
    expect(result.stdout).not.toContain("Shelf is ready");
  });
});
