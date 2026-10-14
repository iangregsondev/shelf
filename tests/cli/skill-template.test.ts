import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { skillTemplate } from "../../src/cli/templates/skill";

const skillFilePath = join(import.meta.dir, "../../.claude/skills/shelf/SKILL.md");

describe("shelf skill", () => {
	test("init template is identical to the repo's skill file", async () => {
		const skillFile = await Bun.file(skillFilePath).text();
		expect(skillTemplate).toBe(skillFile);
	});
});
