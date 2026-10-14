// `shelf alias <old> <new>`: a rename, a case-only rename, a missing alias and a taken alias.

import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";
import { createRemote, type Remote } from "../helpers/git-remote";
import { readJson } from "../helpers/files";

let shelf: ShelfSandbox;
let tempDir: string;
let remote: Remote;

beforeEach(async () => {
  shelf = await createShelfSandbox();
  tempDir = await mkdtemp(join(tmpdir(), "shelf-alias-test-"));
  remote = await createRemote(tempDir);
  expect((await shelf.run(["add", remote.url, "--alias", "lib"])).exitCode).toBe(0);
});

afterEach(async () => {
  await shelf.cleanup();
  await rm(tempDir, { recursive: true, force: true });
});

const storedAliases = async (): Promise<string[]> =>
  ((await readJson(join(shelf.home, "config.json"))) as { repos: { alias: string }[] }).repos.map(
    (r) => r.alias,
  );

const manualAliases = async (): Promise<string[]> =>
  ((await readJson(join(shelf.home, "registry.json"))) as { manual: string[] }).manual;

describe("shelf alias", () => {
  test("renames the folder, the config entry and the manual reference", async () => {
    const result = await shelf.run(["alias", "lib", "renamed"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Renamed "lib" → "renamed"');
    expect(existsSync(join(shelf.home, "repos", "renamed", "file.txt"))).toBe(true);
    expect(existsSync(join(shelf.home, "repos", "lib"))).toBe(false);
    expect(await storedAliases()).toEqual(["renamed"]);
    expect(await manualAliases()).toEqual(["renamed"]);
  });

  test("a case-only rename renames the folder, the config entry and the manual reference", async () => {
    const result = await shelf.run(["alias", "lib", "Lib"]);

    expect(result.exitCode).toBe(0);
    expect(await readdir(join(shelf.home, "repos"))).toEqual(["Lib"]);
    expect(existsSync(join(shelf.home, "repos", "Lib", "file.txt"))).toBe(true);
    expect(await storedAliases()).toEqual(["Lib"]);
    expect(await manualAliases()).toEqual(["Lib"]);
  });

  test("an alias that doesn't exist fails with exit 1 and changes nothing", async () => {
    const result = await shelf.run(["alias", "missing", "renamed"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Repo "missing" not found');
    expect(existsSync(join(shelf.home, "repos", "renamed"))).toBe(false);
    expect(await storedAliases()).toEqual(["lib"]);
  });

  test("a new alias already taken fails with exit 1 and changes nothing", async () => {
    expect((await shelf.run(["add", remote.url, "--alias", "other"])).exitCode).toBe(0);

    const result = await shelf.run(["alias", "lib", "other"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Repo "other" already exists.');
    expect(existsSync(join(shelf.home, "repos", "lib", "file.txt"))).toBe(true);
    expect(existsSync(join(shelf.home, "repos", "other", "file.txt"))).toBe(true);
    expect(await storedAliases()).toEqual(["lib", "other"]);
    expect(await manualAliases()).toEqual(["lib", "other"]);
  });
});
