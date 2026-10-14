// Pins mean what the user typed. Explicit forms are taken as stated, a bare
// value is decided by the remote's tags then branches, a short commit hash is
// stored in full, and `shelf pin` saves a pin only once a sync to it works.
// What got stored is read back through `shelf share --stdout`.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRemote, git, type Remote } from "../helpers/git-remote";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";

let tempDir: string;
let shelf: ShelfSandbox;
let remote: Remote;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "shelf-pins-"));
	shelf = await createShelfSandbox();
	remote = await createRemote(tempDir);
});

afterEach(async () => {
	await shelf.cleanup();
	await rm(tempDir, { recursive: true, force: true });
});

const repoDir = (alias: string): string => join(shelf.home, "repos", alias);
const head = (alias: string): Promise<string> => git(["rev-parse", "HEAD"], repoDir(alias));

/** The shelffile line `shelf share` writes for `alias`. */
const storedLine = async (alias: string): Promise<string | undefined> => {
	const result = await shelf.run(["share", "--stdout"]);
	expect(result.exitCode).toBe(0);
	return result.stdout.split("\n").find((line) => line.startsWith(`${alias} `));
};

const add = (pin: string) => shelf.run(["add", remote.url, "--alias", "lib", "--pin", pin]);

describe("shelf add --pin", () => {
	test("a bare value naming a tag becomes a tag pin", async () => {
		const result = await add("v1");
		expect(result.exitCode).toBe(0);
		expect(await storedLine("lib")).toBe(`lib ${remote.url} pin:tag:v1`);
		expect(await head("lib")).toBe(remote.commits.second);
	});

	test("a bare value naming a branch becomes a branch pin", async () => {
		const result = await add("feature");
		expect(result.exitCode).toBe(0);
		expect(await storedLine("lib")).toBe(`lib ${remote.url} pin:branch:feature`);
		expect(await head("lib")).toBe(remote.commits.first);
	});

	test("a tag wins over a branch of the same name", async () => {
		await remote.branch("v1", remote.commits.third);
		const result = await add("v1");
		expect(result.exitCode).toBe(0);
		expect(await storedLine("lib")).toBe(`lib ${remote.url} pin:tag:v1`);
	});

	test("a bare value naming neither fails, and nothing is added", async () => {
		const result = await add("v9");
		expect(result.exitCode).not.toBe(0);
		expect(result.output).toContain('"v9"');
		expect(await storedLine("lib")).toBeUndefined();
		expect(existsSync(repoDir("lib"))).toBe(false);
	});

	test("a hex-looking branch name is a branch, not a commit", async () => {
		await remote.branch("cafe123", remote.commits.first);
		const result = await add("cafe123");
		expect(result.exitCode).toBe(0);
		expect(await storedLine("lib")).toBe(`lib ${remote.url} pin:branch:cafe123`);
	});

	test("a short commit hash is stored as the full hash", async () => {
		const result = await add(`commit:${remote.commits.first.slice(0, 7)}`);
		expect(result.exitCode).toBe(0);
		expect(await storedLine("lib")).toBe(`lib ${remote.url} pin:${remote.commits.first}`);
		expect(await head("lib")).toBe(remote.commits.first);
	});
});

describe("shelf install", () => {
	test("a short commit pin in a shelffile is stored as the full hash", async () => {
		const project = join(tempDir, "project");
		const short = remote.commits.first.slice(0, 7);
		await Bun.write(join(project, "shelffile"), `lib ${remote.url} pin:commit:${short} # old\n`);

		const result = await shelf.run(["install", "--dir", project]);

		expect(result.output).toContain('Added "lib"');
		expect(await storedLine("lib")).toBe(`lib ${remote.url} pin:${remote.commits.first}`);
	});
});

describe("shelf pin", () => {
	beforeEach(async () => {
		const result = await shelf.run(["add", remote.url, "--alias", "lib"]);
		expect(result.exitCode).toBe(0);
	});

	test("a bare tag name pins to the tag", async () => {
		const result = await shelf.run(["pin", "lib", "v1"]);
		expect(result.exitCode).toBe(0);
		expect(await storedLine("lib")).toBe(`lib ${remote.url} pin:tag:v1`);
		expect(await head("lib")).toBe(remote.commits.second);
	});

	test("a short commit hash outside the shallow clone is fetched and stored in full", async () => {
		const result = await shelf.run(["pin", "lib", `commit:${remote.commits.first.slice(0, 8)}`]);
		expect(result.exitCode).toBe(0);
		expect(await head("lib")).toBe(remote.commits.first);
		expect(await storedLine("lib")).toBe(`lib ${remote.url} pin:${remote.commits.first}`);
	});

	test("a bare value the remote doesn't have fails and changes nothing", async () => {
		const before = await head("lib");
		const result = await shelf.run(["pin", "lib", "nope"]);
		expect(result.exitCode).not.toBe(0);
		expect(await storedLine("lib")).toBe(`lib ${remote.url}`);
		expect(await head("lib")).toBe(before);
	});

	test("a branch pin that can't be checked out is not saved", async () => {
		const result = await shelf.run(["pin", "lib", "branch:nope"]);
		expect(result.exitCode).not.toBe(0);
		expect(await storedLine("lib")).toBe(`lib ${remote.url}`);
	});

	test("a commit the remote doesn't have is not saved", async () => {
		const result = await shelf.run(["pin", "lib", "commit:deadbeef"]);
		expect(result.exitCode).not.toBe(0);
		expect(await storedLine("lib")).toBe(`lib ${remote.url}`);
	});
});
