import * as Option from "effect/Option";

const agentPaths: Record<string, string> = {
  claude: ".claude/skills/shelf",
  opencode: ".opencode/skills/shelf",
  gemini: ".gemini/skills/shelf",
};

const defaultSkillDir = ".agents/skills/shelf";

/** The skill folder, relative to the project, for `agent`; the universal `.agents` one by default. */
export const resolveSkillDir = (agent: Option.Option<string>): string =>
  Option.match(agent, {
    onNone: () => defaultSkillDir,
    onSome: (a) => agentPaths[a] ?? defaultSkillDir,
  });
