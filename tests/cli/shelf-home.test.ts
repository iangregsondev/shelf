import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createBareRepo } from "../helpers/temp-repo";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";

describe("SHELF_HOME", () => {
	let shelf: ShelfSandbox;

	beforeEach(async () => {
		shelf = await createShelfSandbox();
	});

	afterEach(async () => {
		await shelf.cleanup();
	});

	test("add keeps the config and the reference repo inside the shelf home", async () => {
		const repo = await createBareRepo({ "README.md": "# home test" });
		try {
			const result = await shelf.run(["add", repo.dir, "--alias", "home-test"]);
			expect(result.exitCode).toBe(0);

			expect(await Bun.file(join(shelf.home, "repos", "home-test", "README.md")).text()).toBe(
				"# home test",
			);
			const config = (await Bun.file(join(shelf.home, "config.json")).json()) as {
				repos: Array<{ alias: string }>;
			};
			expect(config.repos.map((r) => r.alias)).toEqual(["home-test"]);
		} finally {
			await repo.cleanup();
		}
	});

	test("list reads the shelf home's config", async () => {
		await Bun.write(
			join(shelf.home, "config.json"),
			JSON.stringify({
				version: 1,
				syncIntervalMinutes: 60,
				repos: [
					{
						alias: "seeded-repo",
						url: "file:///nowhere",
						addedAt: "2026-01-01T00:00:00.000Z",
					},
				],
			}),
		);
		const result = await shelf.run(["list"]);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("seeded-repo");
	});
});
