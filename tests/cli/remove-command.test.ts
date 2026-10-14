// `shelf remove`: by alias, by URL and for an unknown repo.

import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";
import { createRemote, type Remote } from "../helpers/git-remote";
import { readJson } from "../helpers/files";

let shelf: ShelfSandbox;
let tempDir: string;
let remote: Remote;
let otherUrl: string;

beforeEach(async () => {
  shelf = await createShelfSandbox();
  tempDir = await mkdtemp(join(tmpdir(), "shelf-remove-test-"));
  remote = await createRemote(tempDir);
  await mkdir(join(tempDir, "other"));
  otherUrl = (await createRemote(join(tempDir, "other"))).url;
  expect((await shelf.run(["add", remote.url, "--alias", "lib"])).exitCode).toBe(0);
  expect((await shelf.run(["add", otherUrl, "--alias", "keep"])).exitCode).toBe(0);
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

describe("shelf remove", () => {
  test("by alias deletes that repo's folder, config entry and manual reference", async () => {
    const result = await shelf.run(["remove", "lib"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Removed repo "lib"');
    expect(existsSync(join(shelf.home, "repos", "lib"))).toBe(false);
    expect(existsSync(join(shelf.home, "repos", "keep", "file.txt"))).toBe(true);
    expect(await storedAliases()).toEqual(["keep"]);
    expect(await manualAliases()).toEqual(["keep"]);
  });

  test("by URL removes the repo cloned from it", async () => {
    const result = await shelf.run(["remove", remote.url]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Removed repo "lib"');
    expect(existsSync(join(shelf.home, "repos", "lib"))).toBe(false);
    expect(await storedAliases()).toEqual(["keep"]);
    expect(await manualAliases()).toEqual(["keep"]);
  });

  test("an unknown repo fails with exit 1 and removes nothing", async () => {
    const result = await shelf.run(["remove", "missing"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'Repo "missing" not found. Run `shelf list` to see available repos.',
    );
    expect(await storedAliases()).toEqual(["lib", "keep"]);
  });
});
