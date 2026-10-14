// `shelf pin <alias> <ref>`: a branch, a tag, a commit, an unknown ref and an
// unknown alias.

import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";
import { createRemote, git, type Remote } from "../helpers/git-remote";
import { readJson } from "../helpers/files";

let shelf: ShelfSandbox;
let tempDir: string;
let remote: Remote;

beforeEach(async () => {
  shelf = await createShelfSandbox();
  tempDir = await mkdtemp(join(tmpdir(), "shelf-pin-test-"));
  remote = await createRemote(tempDir);
  expect((await shelf.run(["add", remote.url, "--alias", "lib"])).exitCode).toBe(0);
});

afterEach(async () => {
  await shelf.cleanup();
  await rm(tempDir, { recursive: true, force: true });
});

const head = (): Promise<string> => git(["rev-parse", "HEAD"], join(shelf.home, "repos", "lib"));

const storedPin = async (): Promise<unknown> =>
  ((await readJson(join(shelf.home, "config.json"))) as { repos: { pin?: unknown }[] }).repos[0]
    ?.pin;

describe("shelf pin", () => {
  test("branch:<name> checks out the branch and stores the pin", async () => {
    const result = await shelf.run(["pin", "lib", "branch:feature"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Pinned "lib" to branch:feature');
    expect(await head()).toBe(remote.commits.first);
    expect(await storedPin()).toEqual({ type: "branch", value: "feature" });
  });

  test("a bare branch name becomes a branch pin", async () => {
    const result = await shelf.run(["pin", "lib", "feature"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Pinned "lib" to branch:feature');
    expect(await head()).toBe(remote.commits.first);
  });

  test("tag:<name> checks out the tag and stores the pin", async () => {
    const result = await shelf.run(["pin", "lib", "tag:v1"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Pinned "lib" to tag:v1');
    expect(await head()).toBe(remote.commits.second);
    expect(await storedPin()).toEqual({ type: "tag", value: "v1" });
  });

  test("commit:<hash> checks out the commit and stores the pin", async () => {
    const result = await shelf.run(["pin", "lib", `commit:${remote.commits.first}`]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Pinned "lib" to commit:${remote.commits.first}`);
    expect(await head()).toBe(remote.commits.first);
    expect(await storedPin()).toEqual({ type: "commit", value: remote.commits.first });
  });

  test("an unknown ref fails with exit 1 and leaves the repo unpinned", async () => {
    const result = await shelf.run(["pin", "lib", "no-such-ref"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Pin failed:");
    expect(await head()).toBe(remote.commits.third);
    expect(await storedPin()).toBeUndefined();
  });

  test("an unknown alias fails with exit 1", async () => {
    const result = await shelf.run(["pin", "missing", "tag:v1"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Repo "missing" not found');
  });
});
