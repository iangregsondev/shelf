import { describe, test, expect } from "vite-plus/test";
import { knownAgents, resolveSkillDir } from "../../../src/domain/skill/skill-utils";

describe("resolveSkillDir", () => {
  test.each([
    ["claude", ".claude/skills/shelf"],
    ["opencode", ".opencode/skills/shelf"],
    ["gemini", ".gemini/skills/shelf"],
  ])("--agent %s reads skills from %s", (agent, dir) => {
    expect(resolveSkillDir(agent)).toBe(dir);
  });

  test("an unknown agent has no skill folder", () => {
    expect(resolveSkillDir("unknown")).toBeUndefined();
  });

  test.each(["toString", "constructor", "__proto__", "hasOwnProperty"])(
    "an agent named after an Object.prototype member (%s) has no skill folder",
    (agent) => {
      expect(resolveSkillDir(agent)).toBeUndefined();
    },
  );
});

describe("knownAgents", () => {
  test("lists claude, opencode and gemini", () => {
    expect(knownAgents).toEqual(["claude", "opencode", "gemini"]);
  });
});
