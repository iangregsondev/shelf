// Sync lands every reference repo on its pin. Each test installs from a
// shelffile pointing at a local `file://` remote with branches, tags and older
// commits, moves the remote on, runs `shelf update` (or `shelf pin`), and
// checks where the reference repo's checkout ended up.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";

const git = async (args: ReadonlyArray<string>, cwd: string): Promise<string> => {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	if (exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
	}
	return stdout.trim();
};

/**
 * A remote with history on `main` (three commits, tag `v1` on the second),
 * and a `feature` branch off the first commit. `work` is a clone that pushes
 * new commits to the bare remote.
 */
interface Remote {
	readonly url: string;
	readonly commits: { readonly first: string; readonly second: string; readonly third: string };
	readonly commit: (branch: string, content: string) => Promise<string>;
}

let tempDir: string;
let shelf: ShelfSandbox;

const createRemote = async (): Promise<Remote> => {
	const work = join(tempDir, "work");
	const bare = join(tempDir, "remote.git");
	await git(["init", "-q", "-b", "main", work], tempDir);
	await git(["config", "user.email", "test@test.com"], work);
	await git(["config", "user.name", "Test"], work);
	const commitFile = async (content: string): Promise<string> => {
		await Bun.write(join(work, "file.txt"), content);
		await git(["add", "file.txt"], work);
		await git(["commit", "-q", "-m", content], work);
		return git(["rev-parse", "HEAD"], work);
	};
	const first = await commitFile("first");
	const second = await commitFile("second");
	await git(["tag", "-a", "v1", "-m", "v1"], work);
	const third = await commitFile("third");
	await git(["branch", "feature", first], work);
	await git(["clone", "-q", "--bare", work, bare], tempDir);
	await git(["remote", "add", "origin", bare], work);

	const commit = async (branch: string, content: string): Promise<string> => {
		await git(["checkout", "-q", branch], work);
		const sha = await commitFile(content);
		await git(["push", "-q", "origin", branch], work);
		return sha;
	};
	return { url: `file://${bare}`, commits: { first, second, third }, commit };
};

const repoDir = (alias: string): string => join(shelf.home, "repos", alias);
const head = (alias: string): Promise<string> => git(["rev-parse", "HEAD"], repoDir(alias));
const isShallow = async (alias: string): Promise<boolean> =>
	(await git(["rev-parse", "--is-shallow-repository"], repoDir(alias))) === "true";

const install = async (alias: string, url: string, pin = ""): Promise<void> => {
	const project = join(tempDir, "project");
	await Bun.write(join(project, "shelffile"), `${alias} ${url} ${pin}\n`);
	const result = await shelf.run(["install", "--dir", project]);
	expect(result.output).toContain(`Added "${alias}"`);
};

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "shelf-sync-pins-"));
	shelf = await createShelfSandbox();
});

afterEach(async () => {
	await shelf.cleanup();
	await rm(tempDir, { recursive: true, force: true });
});

describe("sync keeps every pin type correct", () => {
	test("an unpinned repo moves to the default branch's latest commit", async () => {
		const remote = await createRemote();
		await install("lib", remote.url);
		const tip = await remote.commit("main", "fourth");

		const result = await shelf.run(["update", "lib"]);

		expect(result.exitCode).toBe(0);
		expect(await head("lib")).toBe(tip);
		expect(await isShallow("lib")).toBe(true);
	});

	test("a branch pin moves to the branch tip, fetched at depth 1", async () => {
		const remote = await createRemote();
		await install("lib", remote.url, "pin:branch:feature");
		const tip = await remote.commit("feature", "feature-2");

		const result = await shelf.run(["update", "lib"]);

		expect(result.exitCode).toBe(0);
		expect(await head("lib")).toBe(tip);
		expect(await git(["rev-list", "--count", "HEAD"], repoDir("lib"))).toBe("1");
	});

	test("a tag pin stays on its tag while the default branch moves on", async () => {
		const remote = await createRemote();
		await install("lib", remote.url, "pin:tag:v1");
		await remote.commit("main", "fourth");

		const result = await shelf.run(["update", "lib"]);

		expect(result.exitCode).toBe(0);
		expect(await head("lib")).toBe(remote.commits.second);
		expect(await git(["rev-list", "--count", "HEAD"], repoDir("lib"))).toBe("1");
	});

	test("a commit pin keeps its commit and is never made shallow", async () => {
		const remote = await createRemote();
		await install("lib", remote.url, `pin:${remote.commits.first}`);
		await remote.commit("main", "fourth");

		const result = await shelf.run(["update", "lib"]);

		expect(result.exitCode).toBe(0);
		expect(await head("lib")).toBe(remote.commits.first);
		expect(await isShallow("lib")).toBe(false);
	});

	test("a branch pin outside the original clone syncs to that branch", async () => {
		const remote = await createRemote();
		await install("lib", remote.url);
		const tip = await remote.commit("feature", "feature-2");

		await shelf.run(["pin", "lib", "branch:feature"]);
		expect(await head("lib")).toBe(tip);

		const next = await remote.commit("feature", "feature-3");
		const result = await shelf.run(["update", "lib"]);
		expect(result.exitCode).toBe(0);
		expect(await head("lib")).toBe(next);
	});

	test("a tag pin outside the original clone syncs to that tag", async () => {
		const remote = await createRemote();
		await install("lib", remote.url, "pin:branch:feature");

		await shelf.run(["pin", "lib", "tag:v1"]);
		expect(await head("lib")).toBe(remote.commits.second);

		const result = await shelf.run(["update", "lib"]);
		expect(result.exitCode).toBe(0);
		expect(await head("lib")).toBe(remote.commits.second);
	});

	test("a commit pin outside a shallow clone fetches that commit", async () => {
		const remote = await createRemote();
		await install("lib", remote.url);

		await shelf.run(["pin", "lib", remote.commits.first]);
		expect(await head("lib")).toBe(remote.commits.first);

		const result = await shelf.run(["update", "lib"]);
		expect(result.exitCode).toBe(0);
		expect(await head("lib")).toBe(remote.commits.first);
	});
});
