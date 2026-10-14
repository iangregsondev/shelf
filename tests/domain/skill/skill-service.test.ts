import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillWriteError, UnknownAgentError } from "../../../src/domain/skill/skill-errors";
import { SkillService } from "../../../src/domain/skill/skill-service";
import { skillTemplate } from "../../../src/domain/skill/skill-template";
import { readText, writeText } from "../../helpers/files";
import { PlatformLayer } from "../../helpers/platform";

const runInstall = (projectDir: string, agent: Option.Option<string>) =>
  SkillService.use((skill) => skill.install(projectDir, agent)).pipe(
    Effect.provide(SkillService.layer),
    Effect.provide(PlatformLayer),
  );

const install = (projectDir: string, agent: Option.Option<string>) =>
  Effect.runPromise(runInstall(projectDir, agent));

/** The error `install` fails with; rejects if it succeeds. */
const installError = (projectDir: string, agent: Option.Option<string>) =>
  Effect.runPromise(Effect.flip(runInstall(projectDir, agent)));

describe("SkillService.install", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "shelf-skill-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  test("writes the skill file to the universal .agents folder and returns its path", async () => {
    const path = await install(projectDir, Option.none());
    expect(path).toBe(join(projectDir, ".agents/skills/shelf/SKILL.md"));
    expect(await readText(path)).toBe(skillTemplate);
  });

  test.each([
    ["claude", ".claude/skills/shelf/SKILL.md"],
    ["opencode", ".opencode/skills/shelf/SKILL.md"],
    ["gemini", ".gemini/skills/shelf/SKILL.md"],
  ])("writes to the %s agent's folder", async (agent, relativePath) => {
    const path = await install(projectDir, Option.some(agent));
    expect(path).toBe(join(projectDir, relativePath));
    expect(await readText(path)).toBe(skillTemplate);
  });

  test.each(["codex", "claud", "toString", "constructor", "__proto__"])(
    "rejects the unknown agent %s and writes nothing",
    async (agent) => {
      const error = await installError(projectDir, Option.some(agent));
      expect(error).toBeInstanceOf(UnknownAgentError);
      expect(error).toMatchObject({
        _tag: "UnknownAgentError",
        agent,
        known: ["claude", "opencode", "gemini"],
      });
      expect(await readdir(projectDir)).toEqual([]);
    },
  );

  test("fails with SkillWriteError naming the skill file when its folder cannot be created", async () => {
    // A file stands where the project folder should be.
    const blocker = join(projectDir, "blocker");
    await writeText(blocker, "");
    const error = await installError(blocker, Option.none());
    expect(error).toBeInstanceOf(SkillWriteError);
    expect(error).toMatchObject({
      _tag: "SkillWriteError",
      path: join(blocker, ".agents/skills/shelf/SKILL.md"),
      message: expect.stringContaining("ENOTDIR"),
    });
  });

  test("replaces an existing skill file", async () => {
    await writeText(join(projectDir, ".agents/skills/shelf/SKILL.md"), "old");
    const path = await install(projectDir, Option.none());
    expect(await readText(path)).toBe(skillTemplate);
  });
});
