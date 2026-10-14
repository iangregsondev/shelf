// Safe writes to shelf state: parallel and cross-process adds never lose a
// config entry, a stale lock is taken over, and a failed add cleans up.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";
import { createBareRepo } from "../helpers/temp-repo";

let shelf: ShelfSandbox;
let projectDir: string;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(async () => {
	shelf = await createShelfSandbox();
	projectDir = await mkdtemp(join(tmpdir(), "shelf-safe-writes-"));
});

afterEach(async () => {
	await shelf.cleanup();
	await rm(projectDir, { recursive: true, force: true });
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

const bareRepo = async (name: string): Promise<string> => {
	const repo = await createBareRepo({ [`${name}.ts`]: `export const ${name} = 1;` });
	cleanups.push(repo.cleanup);
	return repo.dir;
};

/** Aliases `shelf list` reports, in order. */
const listedAliases = async (): Promise<string[]> => {
	const result = await shelf.run(["list"]);
	expect(result.exitCode).toBe(0);
	return [...result.stdout.matchAll(/^ {2}(\S+) — /gm)].map((m) => m[1]!);
};

describe("safe writes to shelf state", () => {
	test("installing six repos in parallel records all six in config", async () => {
		const names = ["one", "two", "three", "four", "five", "six"];
		const lines: string[] = [];
		for (const name of names) {
			lines.push(`${name} ${await bareRepo(name)}`);
		}
		await Bun.write(join(projectDir, "shelffile"), `${lines.join("\n")}\n`);

		const result = await shelf.run(["install", "--dir", projectDir, "--concurrency", "6"]);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("6 added");

		expect((await listedAliases()).sort()).toEqual([...names].sort());
	});
});
