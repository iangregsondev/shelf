// Aliases are always a single safe folder name: no flag, shelffile or rename
// can place or delete files outside the shelf, and a rename that fails on disk
// changes nothing.

import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
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
  projectDir = await mkdtemp(join(tmpdir(), "shelf-aliases-"));
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

/** Everything in the shelf home other than its own state files. */
const shelfHomeEntries = async (): Promise<string[]> =>
  existsSync(shelf.home) ? (await readdir(shelf.home)).sort() : [];

describe("aliases", () => {
  test.each([["../escape"], [".."], ["."], ["a/b"], [".hidden"]])(
    "add --alias %j is rejected and creates nothing",
    async (alias) => {
      const result = await shelf.run(["add", await bareRepo("lib"), "--alias", alias]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`Invalid alias "${alias}"`);
      expect(await listedAliases()).toEqual([]);
      expect(existsSync(join(shelf.home, "escape"))).toBe(false);
      const repos = join(shelf.home, "repos");
      expect(existsSync(repos) ? await readdir(repos) : []).toEqual([]);
    },
  );

  test("install rejects a shelffile with a bad alias and adds nothing", async () => {
    const good = await bareRepo("good");
    const evil = await bareRepo("evil");
    await writeText(join(projectDir, "shelffile"), `good ${good}\n../../evil ${evil}\n`);

    const result = await shelf.run(["install", "--dir", projectDir]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Line 2: invalid alias "../../evil"');
    expect(await listedAliases()).toEqual([]);
    expect(await shelfHomeEntries()).not.toContain("evil");
  });

  test("alias rename to a bad alias is rejected and changes nothing", async () => {
    await shelf.run(["add", await bareRepo("lib"), "--alias", "lib"]);

    const result = await shelf.run(["alias", "lib", "../outside"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Invalid alias "../outside"');
    expect(await listedAliases()).toEqual(["lib"]);
    expect(existsSync(join(shelf.home, "repos", "lib"))).toBe(true);
    expect(existsSync(join(shelf.home, "outside"))).toBe(false);
  });

  test("alias rename moves the folder and the config together", async () => {
    await shelf.run(["add", await bareRepo("lib"), "--alias", "lib"]);

    const result = await shelf.run(["alias", "lib", "renamed"]);
    expect(result.exitCode).toBe(0);
    expect(await listedAliases()).toEqual(["renamed"]);
    expect(existsSync(join(shelf.home, "repos", "renamed", "lib.ts"))).toBe(true);
    expect(existsSync(join(shelf.home, "repos", "lib"))).toBe(false);
  });

  test("alias rename that fails on disk changes nothing and exits 1", async () => {
    await shelf.run(["add", await bareRepo("lib"), "--alias", "lib"]);
    await rm(join(shelf.home, "repos", "lib"), { recursive: true, force: true });

    const result = await shelf.run(["alias", "lib", "renamed"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Could not rename "lib" to "renamed"');
    expect(await listedAliases()).toEqual(["lib"]);
  });

  test("info on an alias whose folder is missing says so", async () => {
    await shelf.run(["add", await bareRepo("lib"), "--alias", "lib"]);
    await rm(join(shelf.home, "repos", "lib"), { recursive: true, force: true });

    const result = await shelf.run(["info", "lib"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Alias:       lib");
    expect(result.stdout).toContain("Folder missing");
    expect(result.stderr).toBe("");
  });

  test("add of a scoped package found by search gets a safe alias", async () => {
    const found = await bareRepo("found");
    await shelf.cleanup();
    shelf = await createShelfSandbox({
      github: { "@scope/pkg": [{ clone_url: found, name: "pkg" }] },
    });

    const result = await shelf.run(["add", "@scope/pkg"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Added repo "scope-pkg"');
    expect(existsSync(join(shelf.home, "repos", "scope-pkg", "found.ts"))).toBe(true);
  });

  test("detect names a Go module ending in /vN after the segment before it", async () => {
    await writeText(
      join(projectDir, "go.mod"),
      "module example.com/app\n\ngo 1.21\n\nrequire (\n\tgithub.com/go-chi/chi/v5 v5.0.12\n)\n",
    );

    const result = await shelf.run(["detect", "--dir", projectDir, "--format", "shelffile"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("chi https://github.com/go-chi/chi.git");
  });
});
