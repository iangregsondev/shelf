import { describe, test, expect } from "vite-plus/test";
import * as Option from "effect/Option";
import { resolveSkillDir } from "../../../src/domain/skill/skill-utils";

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

  test.each(["toString", "constructor", "__proto__", "hasOwnProperty"])(
    "agent named after an Object.prototype member (%s) falls back to the default",
    (agent) => {
      expect(resolveSkillDir(Option.some(agent))).toBe(".agents/skills/shelf");
    },
  );
});
