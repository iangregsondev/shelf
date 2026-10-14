// A Map, not an object literal: an object lookup would also match Object.prototype names such as "toString".
const agentPaths: ReadonlyMap<string, string> = new Map([
  ["claude", ".claude/skills/shelf"],
  ["opencode", ".opencode/skills/shelf"],
  ["gemini", ".gemini/skills/shelf"],
]);

/** The agents `--agent` accepts, in the order help and errors list them. */
export const knownAgents: ReadonlyArray<string> = [...agentPaths.keys()];

/** The universal skill folder, relative to the project, used when no agent is named. */
export const defaultSkillDir = ".agents/skills/shelf";

/** The skill folder, relative to the project, that `agent` reads; undefined for an agent shelf doesn't know. */
export const resolveSkillDir = (agent: string): string | undefined => agentPaths.get(agent);
