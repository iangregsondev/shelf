// `shelf prune` with no flags, `--dry-run` and `--force`, against a repo that
// a project installed and then dropped from its shelffile, next to a repo
// added by hand (always referenced). Also how prune treats trash a remove left.

import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";
import { createRemote, type Remote } from "../helpers/git-remote";
import { readJson, readText, writeText } from "../helpers/files";
import { runningAsRoot } from "../helpers/process";

let shelf: ShelfSandbox;
let tempDir: string;
let remote: Remote;
let project: string;

beforeEach(async () => {
  shelf = await createShelfSandbox();
  tempDir = await mkdtemp(join(tmpdir(), "shelf-prune-flags-test-"));
  remote = await createRemote(tempDir);
  project = join(tempDir, "project");
  await writeText(join(project, "shelffile"), `dropped ${remote.url}\n`);
  expect((await shelf.run(["install", "--dir", project])).exitCode).toBe(0);
  expect((await shelf.run(["add", remote.url, "--alias", "manual"])).exitCode).toBe(0);
});

afterEach(async () => {
  await shelf.cleanup();
  await rm(tempDir, { recursive: true, force: true });
});

const repoExists = (alias: string): boolean => existsSync(join(shelf.home, "repos", alias));

const storedAliases = async (): Promise<string[]> =>
  ((await readJson(join(shelf.home, "config.json"))) as { repos: { alias: string }[] }).repos.map(
    (r) => r.alias,
  );

/** Empties the project's shelffile, so `dropped` is referenced by nothing. */
const dropFromShelffile = (): Promise<void> => writeText(join(project, "shelffile"), "");

describe("shelf prune flags", () => {
  test("with nothing unreferenced says so and removes nothing", async () => {
    const result = await shelf.run(["prune", "--force"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No unreferenced repos found.");
    expect(await storedAliases()).toEqual(["dropped", "manual"]);
  });

  test("with no flags lists unreferenced repos, asks for --force and removes nothing", async () => {
    await dropFromShelffile();
    const configBefore = await readText(join(shelf.home, "config.json"));

    const result = await shelf.run(["prune"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Found 1 unreferenced repo(s):\n  dropped — ${remote.url}\n`);
    expect(result.stdout).toContain("Use --force to remove these repos.");
    expect(result.stdout).not.toContain("manual —");
    expect(repoExists("dropped")).toBe(true);
    expect(await readText(join(shelf.home, "config.json"))).toBe(configBefore);
  });

  test("--dry-run lists unreferenced repos without asking for --force, and removes nothing", async () => {
    await dropFromShelffile();
    const configBefore = await readText(join(shelf.home, "config.json"));

    const result = await shelf.run(["prune", "--dry-run"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Found 1 unreferenced repo(s):\n  dropped — ${remote.url}\n`);
    expect(result.stdout).not.toContain("--force");
    expect(result.stdout).not.toContain("Removed");
    expect(repoExists("dropped")).toBe(true);
    expect(await readText(join(shelf.home, "config.json"))).toBe(configBefore);
  });

  test("--force removes only the unreferenced repos", async () => {
    await dropFromShelffile();

    const result = await shelf.run(["prune", "--force"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Removed "dropped"');
    expect(result.stdout).toContain("Pruned 1 repo(s).");
    expect(repoExists("dropped")).toBe(false);
    expect(repoExists("manual")).toBe(true);
    expect(await storedAliases()).toEqual(["manual"]);
  });

  test("with no flags clears trash left by an earlier remove", async () => {
    await mkdir(join(shelf.home, "repos", ".shelf-trash-old-1234", "sub"), { recursive: true });

    const result = await shelf.run(["prune"]);

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(shelf.home, "repos", ".shelf-trash-old-1234"))).toBe(false);
  });

  test("--dry-run leaves trash alone", async () => {
    await mkdir(join(shelf.home, "repos", ".shelf-trash-old-1234"));

    const result = await shelf.run(["prune", "--dry-run"]);

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(shelf.home, "repos", ".shelf-trash-old-1234"))).toBe(true);
  });

  test.skipIf(runningAsRoot)("warns about trash it can't delete", async () => {
    const trash = join(shelf.home, "repos", ".shelf-trash-old-1234");
    await writeText(join(trash, "stuck.txt"), "x");
    await chmod(trash, 0o555);
    try {
      const result = await shelf.run(["prune"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain(`Warning: could not delete ${trash}: EACCES`);
    } finally {
      await chmod(trash, 0o755);
    }
  });

  test.skipIf(runningAsRoot)(
    "--force warns about trash its own removes couldn't delete",
    async () => {
      await dropFromShelffile();
      const repos = join(shelf.home, "repos");
      // A read-only repo folder can be moved aside, but its files not deleted.
      await chmod(join(repos, "dropped"), 0o555);
      let trash: string[] = [];
      try {
        const result = await shelf.run(["prune", "--force"]);
        trash = (await readdir(repos)).filter((name) => name.startsWith(".shelf-trash-dropped-"));

        expect(result.exitCode).toBe(0);
        expect(result.output).toContain('Removed "dropped"');
        expect(trash).toHaveLength(1);
        expect(result.stderr).toContain(
          `Warning: could not delete ${join(repos, trash[0]!)}: EACCES`,
        );
      } finally {
        await Promise.all(trash.map((name) => chmod(join(repos, name), 0o755)));
      }
    },
  );

  test("with no flags deletes the folder of an add that died, and keeps a running one's", async () => {
    const repos = join(shelf.home, "repos");
    const id = "0b7c5d3e-1f2a-4b6c-8d9e-0a1b2c3d4e5f";
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    await mkdir(join(repos, `.shelf-add-killed-${deadPid}-${id}`, ".git"), { recursive: true });
    await mkdir(join(repos, `.shelf-add-running-${process.pid}-${id}`));

    const result = await shelf.run(["prune"]);

    expect(result.exitCode).toBe(0);
    expect((await readdir(repos)).filter((name) => name.startsWith("."))).toEqual([
      `.shelf-add-running-${process.pid}-${id}`,
    ]);
  });
});
