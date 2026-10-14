// `shelf update` with no alias syncs every reference repo, even when some
// fail, names each failure with its reason, and exits 1 if any failed. Each
// test installs reference repos from a shelffile pointing at local `file://`
// remotes, then breaks a remote by deleting it.

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

interface Remote {
	readonly url: string;
	/** The bare repo's directory; deleting it breaks the remote. */
	readonly bare: string;
	/** Pushes a new commit to `main` and returns its sha. */
	readonly commit: (content: string) => Promise<string>;
}

let tempDir: string;
let shelf: ShelfSandbox;

const createRemote = async (name: string): Promise<Remote> => {
	const work = join(tempDir, `${name}-work`);
	const bare = join(tempDir, `${name}.git`);
	await git(["init", "-q", "-b", "main", work], tempDir);
	await git(["config", "user.email", "test@test.com"], work);
	await git(["config", "user.name", "Test"], work);
	const commitFile = async (content: string): Promise<string> => {
		await Bun.write(join(work, "file.txt"), content);
		await git(["add", "file.txt"], work);
		await git(["commit", "-q", "-m", content], work);
		return git(["rev-parse", "HEAD"], work);
	};
	await commitFile(`${name} first`);
	await git(["clone", "-q", "--bare", work, bare], tempDir);
	await git(["remote", "add", "origin", bare], work);
	const commit = async (content: string): Promise<string> => {
		const sha = await commitFile(`${name} ${content}`);
		await git(["push", "-q", "origin", "main"], work);
		return sha;
	};
	return { url: `file://${bare}`, bare, commit };
};

const install = async (repos: Record<string, Remote>): Promise<void> => {
	const project = join(tempDir, "project");
	const lines = Object.entries(repos).map(([alias, remote]) => `${alias} ${remote.url}`);
	await Bun.write(join(project, "shelffile"), `${lines.join("\n")}\n`);
	// One at a time: parallel installs can lose each other's config writes (B24).
	const result = await shelf.run(["install", "--dir", project, "--concurrency", "1"]);
	for (const alias of Object.keys(repos)) {
		expect(result.output).toContain(`Added "${alias}"`);
	}
};

const head = (alias: string): Promise<string> =>
	git(["rev-parse", "HEAD"], join(shelf.home, "repos", alias));

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "shelf-update-failures-"));
	shelf = await createShelfSandbox();
});

afterEach(async () => {
	await shelf.cleanup();
	await rm(tempDir, { recursive: true, force: true });
});

describe("shelf update reports failures", () => {
	test("exits 0 when every reference repo syncs", async () => {
		const a = await createRemote("a");
		const b = await createRemote("b");
		await install({ alpha: a, beta: b });
		const tipA = await a.commit("second");
		const tipB = await b.commit("second");

		const result = await shelf.run(["update"]);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("Update complete.");
		expect(await head("alpha")).toBe(tipA);
		expect(await head("beta")).toBe(tipB);
	});

	test("syncs the rest when one fails, names the failure and its reason, and exits 1", async () => {
		const a = await createRemote("a");
		const b = await createRemote("b");
		const c = await createRemote("c");
		await install({ alpha: a, broken: b, gamma: c });
		const tipA = await a.commit("second");
		const tipC = await c.commit("second");
		await rm(b.bare, { recursive: true, force: true });

		const result = await shelf.run(["update"]);

		expect(result.exitCode).toBe(1);
		expect(await head("alpha")).toBe(tipA);
		expect(await head("gamma")).toBe(tipC);
		expect(result.stderr).toContain("broken");
		// The reason is git's own message about the missing remote.
		expect(result.stderr).toMatch(/broken.*(does not appear to be a git repository|not found)/s);
		expect(result.stderr).not.toContain("alpha");
		expect(result.stderr).not.toContain("gamma");
		expect(result.stderr).toContain("1 of 3");
		expect(result.output).not.toContain("Update complete.");
	});

	test("gives each failure's reason as one line", async () => {
		const b = await createRemote("b");
		await install({ broken: b });
		await rm(b.bare, { recursive: true, force: true });

		const result = await shelf.run(["update"]);

		expect(result.exitCode).toBe(1);
		const lines = result.stderr.trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatch(/"broken" failed: .*fatal: .*does not appear to be a git repository/);
		expect(lines[1]).toContain("1 of 1");
	});
});
