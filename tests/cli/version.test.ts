import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";

// The package manifest is the source of truth for the installed version.
const manifestVersion = async (): Promise<string> => {
	const manifest = (await Bun.file(join(import.meta.dir, "../../package.json")).json()) as {
		version: string;
	};
	return manifest.version;
};

let shelf: ShelfSandbox;

beforeEach(async () => {
	shelf = await createShelfSandbox();
});

afterEach(async () => {
	await shelf.cleanup();
});

describe("version", () => {
	test("shelf --version prints the package manifest version", async () => {
		const result = await shelf.run(["--version"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toContain(await manifestVersion());
	});

	test("the daemon records the package manifest version", async () => {
		// shelf.cleanup() stops the daemon recorded in the state file.
		const result = await shelf.run(["daemon", "start"]);
		expect(result.exitCode).toBe(0);
		const state = (await Bun.file(join(shelf.home, "daemon.json")).json()) as { version?: string };
		expect(state.version).toBe(await manifestVersion());
	}, 20_000);
});
