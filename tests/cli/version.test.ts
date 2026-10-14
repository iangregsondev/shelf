import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import { join } from "node:path";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";
import { readJson } from "../helpers/files";

// The package manifest is the source of truth for the installed version.
const manifestVersion = async (): Promise<string> => {
	const manifest = (await readJson(join(import.meta.dirname, "../../package.json"))) as {
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
		const state = (await readJson(join(shelf.home, "daemon.json"))) as { version?: string };
		expect(state.version).toBe(await manifestVersion());
	}, 20_000);
});
