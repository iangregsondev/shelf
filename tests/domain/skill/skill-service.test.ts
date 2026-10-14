import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillService } from "../../../src/domain/skill/skill-service";
import { skillTemplate } from "../../../src/domain/skill/skill-template";
import { readText, writeText } from "../../helpers/files";
import { PlatformLayer } from "../../helpers/platform";

const install = (projectDir: string, agent: Option.Option<string>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const skill = yield* SkillService;
      return yield* skill.install(projectDir, agent);
    }).pipe(Effect.provide(SkillService.layer), Effect.provide(PlatformLayer)),
  );

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

  test("writes to the universal .agents folder for an unknown agent", async () => {
    const path = await install(projectDir, Option.some("unknown"));
    expect(path).toBe(join(projectDir, ".agents/skills/shelf/SKILL.md"));
    expect(await readText(path)).toBe(skillTemplate);
  });

  test("fails when the skill folder cannot be created", async () => {
    // A file stands where the project folder should be.
    const blocker = join(projectDir, "blocker");
    await writeText(blocker, "");
    const exit = await Effect.runPromiseExit(
      SkillService.use((skill) => skill.install(blocker, Option.none())).pipe(
        Effect.provide(SkillService.layer),
        Effect.provide(PlatformLayer),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });

  test("replaces an existing skill file", async () => {
    await writeText(join(projectDir, ".agents/skills/shelf/SKILL.md"), "old");
    const path = await install(projectDir, Option.none());
    expect(await readText(path)).toBe(skillTemplate);
  });
});
