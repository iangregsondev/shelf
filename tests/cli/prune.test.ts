import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { chmod, mkdtemp, mkdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";
import { createRemote, type Remote } from "../helpers/git-remote";

let shelf: ShelfSandbox;
let tempDir: string;
let remote: Remote;

beforeEach(async () => {
	shelf = await createShelfSandbox();
	tempDir = await mkdtemp(join(tmpdir(), "shelf-prune-test-"));
	remote = await createRemote(tempDir);
});

afterEach(async () => {
	await shelf.cleanup();
	await rm(tempDir, { recursive: true, force: true });
});

const readRegistry = async (): Promise<{ projects: string[]; manual: string[] }> =>
	Bun.file(join(shelf.home, "registry.json")).json();

const repoExists = async (alias: string): Promise<boolean> =>
	stat(join(shelf.home, "repos", alias))
		.then(() => true)
		.catch(() => false);

/** A project folder whose shelffile holds `content`. */
const makeProject = async (name: string, content: string): Promise<string> => {
	const dir = join(tempDir, name);
	await mkdir(dir, { recursive: true });
	await Bun.write(join(dir, "shelffile"), content);
	return dir;
};

describe("prune", () => {
	test("works when a registered project folder was deleted, and drops that registry entry", async () => {
		const gone = await makeProject("gone", `lib-gone ${remote.url}\n`);
		const kept = await makeProject("kept", `lib-kept ${remote.url}\n`);
		expect((await shelf.run(["install", "--dir", gone])).exitCode).toBe(0);
		expect((await shelf.run(["install", "--dir", kept])).exitCode).toBe(0);
		await rm(gone, { recursive: true, force: true });

		const result = await shelf.run(["prune", "--force"]);

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('Removed "lib-gone"');
		expect(await repoExists("lib-gone")).toBe(false);
		expect(await repoExists("lib-kept")).toBe(true);
		expect((await readRegistry()).projects).toEqual([kept]);
	});

	test("--dry-run writes nothing, even with a deleted project to drop", async () => {
		const gone = await makeProject("gone", `lib-gone ${remote.url}\n`);
		expect((await shelf.run(["install", "--dir", gone])).exitCode).toBe(0);
		await rm(gone, { recursive: true, force: true });
		const registryBefore = await Bun.file(join(shelf.home, "registry.json")).text();
		const configBefore = await Bun.file(join(shelf.home, "config.json")).text();

		const result = await shelf.run(["prune", "--dry-run"]);

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("lib-gone");
		expect(await Bun.file(join(shelf.home, "registry.json")).text()).toBe(registryBefore);
		expect(await Bun.file(join(shelf.home, "config.json")).text()).toBe(configBefore);
		expect(await repoExists("lib-gone")).toBe(true);
	});

	test("keeps every repo an unparsable shelffile might reference, and warns", async () => {
		const broken = await makeProject("broken", `lib-broken ${remote.url}\n`);
		const emptied = await makeProject("emptied", `lib-orphan ${remote.url}\n`);
		expect((await shelf.run(["install", "--dir", broken])).exitCode).toBe(0);
		expect((await shelf.run(["install", "--dir", emptied])).exitCode).toBe(0);
		await Bun.write(join(broken, "shelffile"), `lib-broken ${remote.url} pin:not-a-pin\n`);
		await Bun.write(join(emptied, "shelffile"), "");

		const result = await shelf.run(["prune", "--force"]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain(join(broken, "shelffile"));
		expect(await repoExists("lib-broken")).toBe(true);
		expect(result.output).toContain('Removed "lib-orphan"');
		expect(await repoExists("lib-orphan")).toBe(false);
	});

	test("keeps a relative project path an older shelf recorded, and deletes nothing, every run", async () => {
		const project = await makeProject("project", `lib-a ${remote.url}\n`);
		expect((await shelf.run(["install", "--dir", project])).exitCode).toBe(0);
		await Bun.write(
			join(shelf.home, "registry.json"),
			JSON.stringify({ projects: ["project"], manual: [] }),
		);

		for (let run = 0; run < 2; run++) {
			const result = await shelf.run(["prune", "--force"], { cwd: tempDir });

			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain('"project"');
			expect(result.output).toContain("Not removing any repos");
			expect(await repoExists("lib-a")).toBe(true);
			expect((await readRegistry()).projects).toEqual(["project"]);
		}
	});

	test("re-installing from the project replaces its relative path, and prune works again", async () => {
		const project = await makeProject("project", `lib-a ${remote.url}\n`);
		expect((await shelf.run(["install", "--dir", project])).exitCode).toBe(0);
		await Bun.write(
			join(shelf.home, "registry.json"),
			JSON.stringify({ projects: ["project"], manual: [] }),
		);

		const reinstall = await shelf.run(["install", "--dir", "project"], { cwd: tempDir });
		expect(reinstall.exitCode).toBe(0);
		expect((await readRegistry()).projects).toEqual([await realpath(project)]);

		const result = await shelf.run(["prune", "--force"], { cwd: tempDir });
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("No unreferenced repos found.");
	});

	test("deletes nothing when a project's shelffile can't be read at all, and warns", async () => {
		const locked = await makeProject("locked", `lib-locked ${remote.url}\n`);
		const emptied = await makeProject("emptied", `lib-orphan ${remote.url}\n`);
		expect((await shelf.run(["install", "--dir", locked])).exitCode).toBe(0);
		expect((await shelf.run(["install", "--dir", emptied])).exitCode).toBe(0);
		await Bun.write(join(emptied, "shelffile"), "");
		await chmod(join(locked, "shelffile"), 0o000);

		try {
			const result = await shelf.run(["prune", "--force"]);

			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain(join(locked, "shelffile"));
			expect(await repoExists("lib-locked")).toBe(true);
			expect(result.output).toContain("Not removing any repos");
			expect(await repoExists("lib-orphan")).toBe(true);
		} finally {
			await chmod(join(locked, "shelffile"), 0o644);
		}
	});
});

describe("install --dir", () => {
	test("records a relative --dir as an absolute path in the registry", async () => {
		const project = await makeProject("relative-project", `lib-a ${remote.url}\n`);

		const result = await shelf.run(["install", "--dir", "relative-project"], { cwd: tempDir });

		expect(result.exitCode).toBe(0);
		expect((await readRegistry()).projects).toEqual([await realpath(project)]);
	});
});
