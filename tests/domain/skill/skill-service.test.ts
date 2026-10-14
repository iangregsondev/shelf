import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SkillWriteError, UnknownAgentError } from "../../../src/domain/skill/skill-errors";
import { SkillService } from "../../../src/domain/skill/skill-service";
import { skillReposPath, skillTemplate } from "../../../src/domain/skill/skill-template";
import { createMockConfigLayer } from "../config/helpers";
import { readText, writeText } from "../../helpers/files";
import { PlatformLayer } from "../../helpers/platform";

/** The shelf home the tests' config reports, outside the user's home folder. */
const shelfHome = "/tmp/shelf-skill-home";
/** The skill text written for `shelfHome`. */
const expectedSkill = skillTemplate(join(shelfHome, "repos"));

const runInstall = (projectDir: string, agent: Option.Option<string>, home = shelfHome) =>
  SkillService.use((skill) => skill.install(projectDir, agent)).pipe(
    Effect.provide(SkillService.layer),
    Effect.provide(createMockConfigLayer({ shelfHome: home })),
    Effect.provide(PlatformLayer),
  );

const install = (projectDir: string, agent: Option.Option<string>, home?: string) =>
  Effect.runPromise(runInstall(projectDir, agent, home));

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
    expect(await readText(path)).toBe(expectedSkill);
  });

  test.each([
    ["claude", ".claude/skills/shelf/SKILL.md"],
    ["opencode", ".opencode/skills/shelf/SKILL.md"],
    ["gemini", ".gemini/skills/shelf/SKILL.md"],
  ])("writes to the %s agent's folder", async (agent, relativePath) => {
    const path = await install(projectDir, Option.some(agent));
    expect(path).toBe(join(projectDir, relativePath));
    expect(await readText(path)).toBe(expectedSkill);
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

  test("names the shelf home's repos folder as an absolute path when it is outside the user's home", async () => {
    const text = await readText(await install(projectDir, Option.none()));
    expect(text).toContain("`/tmp/shelf-skill-home/repos/{alias}/`");
    expect(text).not.toContain("~/.agents/shelf/repos");
  });

  test("names the default shelf home's repos folder as ~/.agents/shelf/repos", async () => {
    const path = await install(projectDir, Option.none(), join(homedir(), ".agents", "shelf"));
    const text = await readText(path);
    expect(text).toBe(skillTemplate("~/.agents/shelf/repos"));
    expect(text).toContain("`~/.agents/shelf/repos/{alias}/`");
    expect(text).not.toContain(homedir() + "/");
  });

  test("replaces an existing skill file", async () => {
    await writeText(join(projectDir, ".agents/skills/shelf/SKILL.md"), "old");
    const path = await install(projectDir, Option.none());
    expect(await readText(path)).toBe(expectedSkill);
  });
});

describe("skillReposPath", () => {
  test.each([
    ["/home/ian/.agents/shelf/repos", "~/.agents/shelf/repos"],
    ["/home/ian/custom/repos", "~/custom/repos"],
    ["/home/ian", "~"],
    ["/home/ianx/repos", "/home/ianx/repos"],
    ["/home/ian/..repos", "~/..repos"],
    ["/srv/shelf/repos", "/srv/shelf/repos"],
  ])("shows %s as %s for the home folder /home/ian", (reposDir, shown) => {
    expect(skillReposPath(reposDir, "/home/ian")).toBe(shown);
  });
});

describe("skillTemplate", () => {
  test("uses the given repos path everywhere it names the repos folder", () => {
    const text = skillTemplate("/srv/shelf/repos");
    expect(text).toContain("cached at\n  /srv/shelf/repos/{alias}/");
    expect(text).toContain("`/srv/shelf/repos/{alias}/**/*.ts`");
    expect(text).toContain("`ls /srv/shelf/repos/{alias}/src/`");
    expect(text).not.toContain("~/.agents/shelf/repos");
  });
});
