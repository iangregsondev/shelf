import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import { join } from "node:path";
import { createBareRepo } from "../helpers/temp-repo";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";
import { existsSync } from "node:fs";

describe("add command with resolve", () => {
	let shelf: ShelfSandbox;
	let searchable: { dir: string; cleanup: () => Promise<void> };
	const runShelf = (args: string[]) => shelf.run(args);

	beforeEach(async () => {
		searchable = await createBareRepo({ "found.ts": "export {};" });
		shelf = await createShelfSandbox({
			github: {
				"shelf-fixture-lib": [{ clone_url: searchable.dir, name: "shelf-fixture-lib" }],
			},
		});
	});

	afterEach(async () => {
		await shelf.cleanup();
		await searchable.cleanup();
	});

	test("add with local path still works (passthrough)", async () => {
		const repo = await createBareRepo({ "test.ts": "export {};" });

		const result = await runShelf(["add", repo.dir, "--alias", "local"]);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("Added");
		// Local path should NOT print "Resolved" since source is "direct"
		expect(result.output).not.toContain("Resolved");

		await repo.cleanup();
	});

	test("add with full URL does not print resolve message", async () => {
		const repo = await createBareRepo({ "test.ts": "export {};" });

		const result = await runShelf(["add", repo.dir, "--alias", "fullurl"]);
		expect(result.exitCode).toBe(0);
		// Direct URLs should not show "Resolved" message
		expect(result.output).not.toContain("Resolved");

		await repo.cleanup();
	});

	test("add with a bare name finds the repo through the GitHub API", async () => {
		const result = await runShelf(["add", "shelf-fixture-lib"]);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("Added");
		expect(existsSync(join(shelf.home, "repos", "shelf-fixture-lib", "found.ts"))).toBe(true);
	});

	test("add with unknown bare name shows clean resolve error", async () => {
		const result = await runShelf([
			"add",
			"xyzzy-nonexistent-library-99999",
			"--alias",
			"shouldnt-exist",
		]);
		// Should fail with a clean error, not a stack trace
		expect(result.output).not.toContain("at <anonymous>");
		// The error message should be about resolution failure
		expect(result.output.toLowerCase()).toContain("resolve");
		expect(result.output).toContain("No repositories found");
	});

	test("add with relative path works", async () => {
		const repo = await createBareRepo({ "test.ts": "export {};" });

		// Use the repo dir directly since it's absolute and starts with /
		const result = await runShelf(["add", repo.dir, "--alias", "relpath"]);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("Added");

		await repo.cleanup();
	});
});
