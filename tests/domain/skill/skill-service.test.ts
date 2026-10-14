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

  test("writes to the named agent's folder", async () => {
    const path = await install(projectDir, Option.some("claude"));
    expect(path).toBe(join(projectDir, ".claude/skills/shelf/SKILL.md"));
    expect(await readText(path)).toBe(skillTemplate);
  });

  test("replaces an existing skill file", async () => {
    await writeText(join(projectDir, ".agents/skills/shelf/SKILL.md"), "old");
    const path = await install(projectDir, Option.none());
    expect(await readText(path)).toBe(skillTemplate);
  });
});
