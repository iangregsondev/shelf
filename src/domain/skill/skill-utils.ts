import * as Option from "effect/Option";

// A Map, not an object literal: an object lookup would also match Object.prototype names such as "toString".
const agentPaths: ReadonlyMap<string, string> = new Map([
  ["claude", ".claude/skills/shelf"],
  ["opencode", ".opencode/skills/shelf"],
  ["gemini", ".gemini/skills/shelf"],
]);

const defaultSkillDir = ".agents/skills/shelf";

/** The skill folder, relative to the project, for `agent`; the universal `.agents` one by default. */
export const resolveSkillDir = (agent: Option.Option<string>): string =>
  Option.match(agent, {
    onNone: () => defaultSkillDir,
    onSome: (a) => agentPaths.get(a) ?? defaultSkillDir,
  });
