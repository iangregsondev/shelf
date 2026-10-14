// Sync lands every reference repo on its pin. Each test installs from a
// shelffile pointing at a local `file://` remote with branches, tags and older
// commits, moves the remote on, runs `shelf update` (or `shelf pin`), and
// checks where the reference repo's checkout ended up.

import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRemote as createRemoteIn, git } from "../helpers/git-remote";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";
import { writeText } from "../helpers/files";

let tempDir: string;
let shelf: ShelfSandbox;

const createRemote = () => createRemoteIn(tempDir);

const repoDir = (alias: string): string => join(shelf.home, "repos", alias);
const head = (alias: string): Promise<string> => git(["rev-parse", "HEAD"], repoDir(alias));
const isShallow = async (alias: string): Promise<boolean> =>
  (await git(["rev-parse", "--is-shallow-repository"], repoDir(alias))) === "true";

const install = async (alias: string, url: string, pin = ""): Promise<void> => {
  const project = join(tempDir, "project");
  await writeText(join(project, "shelffile"), `${alias} ${url} ${pin}\n`);
  const result = await shelf.run(["install", "--dir", project]);
  expect(result.output).toContain(`Added "${alias}"`);
};

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "shelf-sync-pins-"));
  shelf = await createShelfSandbox();
});

afterEach(async () => {
  await shelf.cleanup();
  await rm(tempDir, { recursive: true, force: true });
});

describe("sync keeps every pin type correct", () => {
  test("an unpinned repo moves to the default branch's latest commit", async () => {
    const remote = await createRemote();
    await install("lib", remote.url);
    const tip = await remote.commit("main", "fourth");

    const result = await shelf.run(["update", "lib"]);

    expect(result.exitCode).toBe(0);
    expect(await head("lib")).toBe(tip);
    expect(await isShallow("lib")).toBe(true);
  });

  test("a branch pin moves to the branch tip, fetched at depth 1", async () => {
    const remote = await createRemote();
    await install("lib", remote.url, "pin:branch:feature");
    const tip = await remote.commit("feature", "feature-2");

    const result = await shelf.run(["update", "lib"]);

    expect(result.exitCode).toBe(0);
    expect(await head("lib")).toBe(tip);
    expect(await git(["rev-list", "--count", "HEAD"], repoDir("lib"))).toBe("1");
  });

  test("a tag pin stays on its tag while the default branch moves on", async () => {
    const remote = await createRemote();
    await install("lib", remote.url, "pin:tag:v1");
    await remote.commit("main", "fourth");

    const result = await shelf.run(["update", "lib"]);

    expect(result.exitCode).toBe(0);
    expect(await head("lib")).toBe(remote.commits.second);
    expect(await git(["rev-list", "--count", "HEAD"], repoDir("lib"))).toBe("1");
  });

  test("a commit pin keeps its commit and is never made shallow", async () => {
    const remote = await createRemote();
    await install("lib", remote.url, `pin:${remote.commits.first}`);
    await remote.commit("main", "fourth");

    const result = await shelf.run(["update", "lib"]);

    expect(result.exitCode).toBe(0);
    expect(await head("lib")).toBe(remote.commits.first);
    expect(await isShallow("lib")).toBe(false);
  });

  test("a branch pin outside the original clone syncs to that branch", async () => {
    const remote = await createRemote();
    await install("lib", remote.url);
    const tip = await remote.commit("feature", "feature-2");

    await shelf.run(["pin", "lib", "branch:feature"]);
    expect(await head("lib")).toBe(tip);

    const next = await remote.commit("feature", "feature-3");
    const result = await shelf.run(["update", "lib"]);
    expect(result.exitCode).toBe(0);
    expect(await head("lib")).toBe(next);
  });

  test("a tag pin outside the original clone syncs to that tag", async () => {
    const remote = await createRemote();
    await install("lib", remote.url, "pin:branch:feature");

    await shelf.run(["pin", "lib", "tag:v1"]);
    expect(await head("lib")).toBe(remote.commits.second);

    const result = await shelf.run(["update", "lib"]);
    expect(result.exitCode).toBe(0);
    expect(await head("lib")).toBe(remote.commits.second);
  });

  test("a commit pin outside a shallow clone fetches that commit", async () => {
    const remote = await createRemote();
    await install("lib", remote.url);

    await shelf.run(["pin", "lib", remote.commits.first]);
    expect(await head("lib")).toBe(remote.commits.first);

    const result = await shelf.run(["update", "lib"]);
    expect(result.exitCode).toBe(0);
    expect(await head("lib")).toBe(remote.commits.first);
  });
});
