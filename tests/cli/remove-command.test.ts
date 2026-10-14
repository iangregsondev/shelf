// `shelf remove`: by alias, by URL, for an orphan folder, when the folder
// can't be moved or deleted, and for an unknown repo.

import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";
import { createRemote, type Remote } from "../helpers/git-remote";
import { readJson } from "../helpers/files";
import { runningAsRoot } from "../helpers/process";

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

  test("an orphan folder with no config entry is removed and reported", async () => {
    await mkdir(join(shelf.home, "repos", "ghost"));

    const result = await shelf.run(["remove", "ghost"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Removed orphan folder for "ghost" (it had no config entry).');
    expect(existsSync(join(shelf.home, "repos", "ghost"))).toBe(false);
    expect(await storedAliases()).toEqual(["lib", "keep"]);
  });

  test.skipIf(runningAsRoot)(
    "a folder that can't be moved aside fails, and keeps the folder and the config entry",
    async () => {
      const repos = join(shelf.home, "repos");
      await chmod(repos, 0o555);
      try {
        const result = await shelf.run(["remove", "lib"]);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(
          `Could not move the repo folder ${join(repos, "lib")} aside to remove it: EACCES`,
        );
        expect(result.stderr).toContain("The folder and its config entry were kept.");
      } finally {
        await chmod(repos, 0o755);
      }
      expect(existsSync(join(repos, "lib", "file.txt"))).toBe(true);
      expect(existsSync(join(repos, "lib", ".git", "HEAD"))).toBe(true);
      expect(await storedAliases()).toEqual(["lib", "keep"]);
      expect(await manualAliases()).toEqual(["lib", "keep"]);
    },
  );

  test.skipIf(runningAsRoot)(
    "a folder that can't be deleted is still removed from the shelf, leaving trash and a warning",
    async () => {
      const repos = join(shelf.home, "repos");
      // A read-only repo folder can be moved aside, but its files not deleted.
      await chmod(join(repos, "lib"), 0o555);
      let trash: string[] = [];
      try {
        const result = await shelf.run(["remove", "lib"]);
        trash = (await readdir(repos)).filter((name) => name.startsWith(".shelf-trash-lib-"));

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Removed repo "lib"');
        expect(trash).toHaveLength(1);
        expect(result.stderr).toContain(
          `Warning: could not delete ${join(repos, trash[0]!)}: EACCES`,
        );
        expect(result.stderr).toContain("`shelf remove` or `shelf prune` will try again.");
      } finally {
        await Promise.all(trash.map((name) => chmod(join(repos, name), 0o755)));
      }
      expect((await readdir(repos)).sort()).toEqual([...trash, "keep"].sort());
      expect(await storedAliases()).toEqual(["keep"]);
      expect(await manualAliases()).toEqual(["keep"]);
    },
  );

  test("clears trash left by an earlier remove", async () => {
    const repos = join(shelf.home, "repos");
    await mkdir(join(repos, ".shelf-trash-old-1234", "sub"), { recursive: true });

    const result = await shelf.run(["remove", "lib"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(await readdir(repos)).toEqual(["keep"]);
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
