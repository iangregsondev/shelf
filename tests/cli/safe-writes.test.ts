// Safe writes to shelf state: parallel and cross-process adds never lose a
// config entry, a stale lock is taken over, and a failed add cleans up.

import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";
import { createBareRepo } from "../helpers/temp-repo";
import { writeText } from "../helpers/files";

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
    await writeText(join(projectDir, "shelffile"), `${lines.join("\n")}\n`);

    const result = await shelf.run(["install", "--dir", projectDir, "--concurrency", "6"]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("6 added");

    expect((await listedAliases()).sort()).toEqual([...names].sort());
  });

  test("CLI processes adding at the same time all end up in config", async () => {
    const names = ["alpha", "beta", "gamma", "delta"];
    const dirs = await Promise.all(names.map(bareRepo));

    const results = await Promise.all(
      names.map((name, i) => shelf.run(["add", dirs[i]!, "--alias", name])),
    );
    for (const result of results) {
      expect(result.output).toContain("Added repo");
    }

    expect((await listedAliases()).sort()).toEqual([...names].sort());
    expect(existsSync(join(shelf.home, "config.json.lock"))).toBe(false);
  });

  test("a lock file left by a dead process is taken over", async () => {
    const dead = spawn("true");
    await once(dead, "exit");
    await mkdir(shelf.home, { recursive: true });
    await writeFile(join(shelf.home, "config.json.lock"), String(dead.pid));

    const result = await shelf.run(["add", await bareRepo("orphan"), "--alias", "orphan"]);
    expect(result.output).toContain('Added repo "orphan"');

    expect(await listedAliases()).toEqual(["orphan"]);
    expect(existsSync(join(shelf.home, "config.json.lock"))).toBe(false);
  });

  test("a failed add removes the folder it created, so a retry succeeds", async () => {
    const dir = await bareRepo("retry");
    // Clones fine, then fails checking out a commit the repo doesn't have.
    const missingCommit = "deadbeef".repeat(5);

    const failed = await shelf.run(["add", dir, "--alias", "retry", "--pin", missingCommit]);
    expect(failed.output).not.toContain("Added repo");
    expect(existsSync(join(shelf.home, "repos", "retry"))).toBe(false);

    const retry = await shelf.run(["add", dir, "--alias", "retry"]);
    expect(retry.output).toContain('Added repo "retry"');
    expect(await listedAliases()).toEqual(["retry"]);
  });
});
