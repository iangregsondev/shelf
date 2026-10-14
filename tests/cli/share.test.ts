// `shelf share` turns the shelf's reference repos into a shelffile, written
// to the current directory or printed.

import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";
import { createBareRepo } from "../helpers/temp-repo";
import { readText } from "../helpers/files";

let shelf: ShelfSandbox;
let project: string;
let remotes: Array<{ dir: string; cleanup: () => Promise<void> }>;

beforeEach(async () => {
  shelf = await createShelfSandbox();
  project = await mkdtemp(join(tmpdir(), "shelf-share-"));
  remotes = [await createBareRepo(), await createBareRepo()];
  for (const [alias, remote] of [
    ["alpha", remotes[0]!],
    ["beta", remotes[1]!],
  ] as const) {
    const add = await shelf.run(["add", remote.dir, "--alias", alias]);
    expect(add.exitCode).toBe(0);
  }
});

afterEach(async () => {
  await shelf.cleanup();
  await rm(project, { recursive: true, force: true });
  for (const remote of remotes) await remote.cleanup();
});

const lines = (text: string): string[] => text.trimEnd().split("\n").sort();

describe("shelf share", () => {
  test("with no flags writes a shelffile with every repo to the current directory", async () => {
    const result = await shelf.run(["share"], { cwd: project });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("Wrote shelffile with 2 entries");
    expect(lines(await readText(join(project, "shelffile")))).toEqual([
      `alpha ${remotes[0]!.dir}`,
      `beta ${remotes[1]!.dir}`,
    ]);
  });

  test("--filter keeps only the named aliases", async () => {
    const result = await shelf.run(["share", "--filter", "beta, nope"], { cwd: project });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("Wrote shelffile with 1 entries");
    expect(lines(await readText(join(project, "shelffile")))).toEqual([`beta ${remotes[1]!.dir}`]);
  });

  test("--stdout prints the shelffile and writes nothing", async () => {
    const result = await shelf.run(["share", "--stdout"], { cwd: project });
    expect(result.exitCode).toBe(0);
    expect(lines(result.stdout)).toEqual([`alpha ${remotes[0]!.dir}`, `beta ${remotes[1]!.dir}`]);
    expect(existsSync(join(project, "shelffile"))).toBe(false);
  });
});
