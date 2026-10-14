import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";
import { createBareRepo } from "../helpers/temp-repo";
import { writeText } from "../helpers/files";

let shelf: ShelfSandbox;
let cleanups: Array<() => Promise<void>>;

beforeEach(async () => {
	shelf = await createShelfSandbox();
	cleanups = [];
});

afterEach(async () => {
	await shelf.cleanup();
	for (const cleanup of cleanups) await cleanup();
});

const bareRepo = async (): Promise<string> => {
	const bare = await createBareRepo({ "index.ts": "export const x = 1;" });
	cleanups.push(bare.cleanup);
	return bare.dir;
};

describe("shelf status", () => {
	test("with no repos says how to add one", async () => {
		const result = await shelf.run(["status"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("No repos configured. Use `shelf add <url>` to add one.");
	});

	test("shows each repo's url, pin, sync time, size and manual reference", async () => {
		const url = await bareRepo();
		await shelf.run(["add", url, "--alias", "lib"]);

		const result = await shelf.run(["status"]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain(`  lib — ${url}`);
		expect(result.stdout).toMatch(
			/Pin: \(default branch\) {2}\| {2}Synced: \S+ {2}\| {2}Size: \d+\.\d MB/,
		);
		expect(result.stdout).not.toContain("Synced: never");
		expect(result.stdout).toContain("Referenced by: manual");
	});

	test("lists the projects whose shelffile uses a repo", async () => {
		const url = await bareRepo();
		const project = await mkdtemp(join(tmpdir(), "shelf-status-project-"));
		cleanups.push(() => rm(project, { recursive: true, force: true }));
		await writeText(join(project, "shelffile"), `lib ${url}\n`);
		const install = await shelf.run(["install", "--dir", project]);
		expect(install.exitCode).toBe(0);

		const result = await shelf.run(["status"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(`Referenced by: ${project}`);
	});

	test("flags a repo nothing references as a prune candidate", async () => {
		const url = await bareRepo();
		const project = await mkdtemp(join(tmpdir(), "shelf-status-project-"));
		cleanups.push(() => rm(project, { recursive: true, force: true }));
		await writeText(join(project, "shelffile"), `lib ${url}\n`);
		await shelf.run(["install", "--dir", project]);
		await writeText(join(project, "shelffile"), "");

		const result = await shelf.run(["status"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Unreferenced (candidate for `shelf prune`)");
	});
});
