import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";

const CLI = join(import.meta.dir, "../../src/startup/index.ts");

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
		// `daemon start` does not return yet (it waits on the daemon child), so
		// run it directly, wait for the state file, then stop the CLI process.
		// shelf.cleanup() kills the daemon recorded in the state file.
		const cli = Bun.spawn(["bun", "run", CLI, "daemon", "start"], {
			stdout: "ignore",
			stderr: "ignore",
			env: shelf.env,
		});
		try {
			const statePath = join(shelf.home, "daemon.json");
			const deadline = Date.now() + 4000;
			let state: { version?: string } | undefined;
			while (Date.now() < deadline) {
				try {
					state = (await Bun.file(statePath).json()) as { version?: string };
					break;
				} catch {
					await Bun.sleep(50);
				}
			}
			expect(state?.version).toBe(await manifestVersion());
		} finally {
			cli.kill("SIGKILL");
			await cli.exited;
		}
	});
});
