import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";

let shelf: ShelfSandbox;
const runShelf = (args: string[], cwd?: string) => shelf.run(args, { cwd });

beforeEach(async () => {
	shelf = await createShelfSandbox();
});

afterEach(async () => {
	await shelf.cleanup();
});

describe("daemon command", () => {
	test("daemon status returns successfully", async () => {
		const result = await runShelf(["daemon", "status"]);
		expect(result.exitCode).toBe(0);
		// Should report running or not running
		const output = result.output.toLowerCase();
		expect(output.includes("running") || output.includes("not running")).toBe(true);
	});

	test("daemon stop shows clean output", async () => {
		const result = await runShelf(["daemon", "stop"]);
		// Should either stop a running daemon or show a clean error
		expect(result.output).not.toContain("at <anonymous>");
		const output = result.output.toLowerCase();
		expect(output.includes("stopped") || output.includes("no daemon")).toBe(true);
	});

	test("daemon logs returns successfully", async () => {
		const result = await runShelf(["daemon", "logs"]);
		expect(result.exitCode).toBe(0);
	});

	test("daemon logs with --lines flag works", async () => {
		const result = await runShelf(["daemon", "logs", "--lines", "10"]);
		expect(result.exitCode).toBe(0);
	});
});
