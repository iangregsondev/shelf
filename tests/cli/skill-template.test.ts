import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { skillTemplate } from "../../src/cli/templates/skill";

const skillFilePath = join(import.meta.dir, "../../.claude/skills/shelf/SKILL.md");

describe("shelf skill", () => {
	test("init template is identical to the repo's skill file", async () => {
		const skillFile = await Bun.file(skillFilePath).text();
		expect(skillTemplate).toBe(skillFile);
	});

	test("description fits the 1,024-character skill limit", async () => {
		const skillFile = await Bun.file(skillFilePath).text();
		const frontmatter = skillFile.split(/^---$/m)[1] ?? "";
		const { description } = Bun.YAML.parse(frontmatter) as { description: string };
		expect(description.length).toBeGreaterThan(0);
		expect(description.length).toBeLessThanOrEqual(1024);
	});
});
