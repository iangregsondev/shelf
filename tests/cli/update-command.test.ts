// `shelf update`: no alias, an alias and an unknown alias.

import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";
import { createRemote, git, type Remote } from "../helpers/git-remote";

let shelf: ShelfSandbox;
let tempDir: string;
let a: Remote;
let b: Remote;

beforeEach(async () => {
  shelf = await createShelfSandbox();
  tempDir = await mkdtemp(join(tmpdir(), "shelf-update-test-"));
  await mkdir(join(tempDir, "a"));
  await mkdir(join(tempDir, "b"));
  a = await createRemote(join(tempDir, "a"));
  b = await createRemote(join(tempDir, "b"));
  expect((await shelf.run(["add", a.url, "--alias", "a"])).exitCode).toBe(0);
  expect((await shelf.run(["add", b.url, "--alias", "b"])).exitCode).toBe(0);
});

afterEach(async () => {
  await shelf.cleanup();
  await rm(tempDir, { recursive: true, force: true });
});

const head = (alias: string): Promise<string> =>
  git(["rev-parse", "HEAD"], join(shelf.home, "repos", alias));

describe("shelf update", () => {
  test("with no alias syncs every repo", async () => {
    const tipA = await a.commit("main", "fourth");
    const tipB = await b.commit("main", "fourth");

    const result = await shelf.run(["update"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Update complete.");
    expect(await head("a")).toBe(tipA);
    expect(await head("b")).toBe(tipB);
  });

  test("with an alias syncs only that repo", async () => {
    const tipA = await a.commit("main", "fourth");
    await b.commit("main", "fourth");

    const result = await shelf.run(["update", "a"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Update complete.");
    expect(await head("a")).toBe(tipA);
    expect(await head("b")).toBe(b.commits.third);
  });

  test("with an unknown alias fails with exit 1 and syncs nothing", async () => {
    await a.commit("main", "fourth");

    const result = await shelf.run(["update", "missing"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Repo "missing" not found');
    expect(result.stdout).not.toContain("Update complete.");
    expect(await head("a")).toBe(a.commits.third);
  });
});
