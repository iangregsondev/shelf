import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";

let shelf: ShelfSandbox;

beforeEach(async () => {
	shelf = await createShelfSandbox();
});

afterEach(async () => {
	await shelf.cleanup();
});

describe("shelf config syncIntervalMinutes", () => {
	test("sets a whole number of 1 or more", async () => {
		const set = await shelf.run(["config", "syncIntervalMinutes", "15"]);
		expect(set.exitCode).toBe(0);
		const get = await shelf.run(["config", "syncIntervalMinutes"]);
		expect(get.stdout.trim()).toBe("15");
	});

	test.each(["0", "-1", "1.5", "abc"])("rejects %j and keeps the old value", async (value) => {
		const set = await shelf.run(["config", "syncIntervalMinutes", "--", value]);
		expect(set.exitCode).toBe(1);
		expect(set.stderr).toContain("syncIntervalMinutes must be a whole number of 1 or more");
		const get = await shelf.run(["config", "syncIntervalMinutes"]);
		expect(get.stdout.trim()).toBe("60");
	});
});

describe("shelf config <unknown key>", () => {
	test.each([[["config", "nope"]], [["config", "nope", "5"]]])(
		"%j fails with exit 1 and names the key",
		async (args) => {
			const result = await shelf.run(args);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain('Unknown config key "nope"');
		},
	);
});
