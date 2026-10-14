import { describe, test, expect } from "vite-plus/test";
import { join } from "node:path";
import { skillTemplate } from "../../src/domain/skill/skill-template";
import { parse } from "yaml";
import { readText } from "../helpers/files";

const skillFilePath = join(import.meta.dirname, "../../.claude/skills/shelf/SKILL.md");

describe("shelf skill", () => {
  test("init template is identical to the repo's skill file", async () => {
    const skillFile = await readText(skillFilePath);
    expect(skillTemplate("~/.agents/shelf/repos")).toBe(skillFile);
  });

  test("description fits the 1,024-character skill limit", async () => {
    const skillFile = await readText(skillFilePath);
    const frontmatter = skillFile.split(/^---$/m)[1] ?? "";
    const { description } = parse(frontmatter) as { description: string };
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(1024);
  });
});
