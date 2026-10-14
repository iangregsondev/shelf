// `shelf add` for each shorthand form and each flag. Shorthand forms expand to
// https://github.com/... URLs; git's `url.<base>.insteadOf` (set through
// GIT_CONFIG_* env vars) points those at local bare repos, so nothing touches
// the network.

import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";
import { createRemote, git, type Remote } from "../helpers/git-remote";
import { createTempRepo } from "../helpers/temp-repo";
import { readJson } from "../helpers/files";

let shelf: ShelfSandbox;
let tempDir: string;
let fakeGitHub: string;

/** Makes `owner/repo` on the fake GitHub: a bare repo holding `files`. */
const publish = async (ownerRepo: string, files: Record<string, string>): Promise<void> => {
  const source = await createTempRepo(files);
  try {
    const target = join(fakeGitHub, `${ownerRepo}.git`);
    await mkdir(join(target, ".."), { recursive: true });
    await git(["clone", "-q", "--bare", source.dir, target], tempDir);
  } finally {
    await source.cleanup();
  }
};

interface StoredRepo {
  readonly alias: string;
  readonly url: string;
  readonly pin?: { readonly type: string; readonly value: string };
}

const storedRepos = async (): Promise<ReadonlyArray<StoredRepo>> =>
  ((await readJson(join(shelf.home, "config.json"))) as { repos: StoredRepo[] }).repos;

const repoDir = (alias: string): string => join(shelf.home, "repos", alias);

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "shelf-add-test-"));
  fakeGitHub = join(tempDir, "github");
  await mkdir(fakeGitHub, { recursive: true });
  shelf = await createShelfSandbox(
    {},
    {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.file://${fakeGitHub}/.insteadOf`,
      GIT_CONFIG_VALUE_0: "https://github.com/",
    },
  );
});

afterEach(async () => {
  await shelf.cleanup();
  await rm(tempDir, { recursive: true, force: true });
});

describe("shelf add shorthand forms", () => {
  test("owner/repo resolves to its GitHub URL and is aliased by the repo name", async () => {
    await publish("acme/widget", { "widget.ts": "export {};" });

    const result = await shelf.run(["add", "acme/widget"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Resolved "acme/widget" → https://github.com/acme/widget.git');
    expect(result.stdout).toContain('Added repo "widget"');
    expect(existsSync(join(repoDir("widget"), "widget.ts"))).toBe(true);
    expect(await storedRepos()).toMatchObject([
      { alias: "widget", url: "https://github.com/acme/widget.git" },
    ]);
  });

  test("github:owner/repo resolves to its GitHub URL", async () => {
    await publish("acme/gadget", { "gadget.ts": "export {};" });

    const result = await shelf.run(["add", "github:acme/gadget"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      'Resolved "github:acme/gadget" → https://github.com/acme/gadget.git',
    );
    expect(result.stdout).toContain('Added repo "gadget"');
    expect(existsSync(join(repoDir("gadget"), "gadget.ts"))).toBe(true);
  });

  test("a full https URL is used as given, aliased by the repo name", async () => {
    await publish("acme/gizmo", { "gizmo.ts": "export {};" });

    const result = await shelf.run(["add", "https://github.com/acme/gizmo.git"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("Resolved");
    expect(result.stdout).toContain('Added repo "gizmo"');
    expect(existsSync(join(repoDir("gizmo"), "gizmo.ts"))).toBe(true);
    expect(await storedRepos()).toMatchObject([
      { alias: "gizmo", url: "https://github.com/acme/gizmo.git" },
    ]);
  });

  test("a known package name resolves through the built-in list", async () => {
    await publish("colinhacks/zod", { "zod.ts": "export {};" });

    const result = await shelf.run(["add", "zod"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Resolved "zod" → https://github.com/colinhacks/zod.git');
    expect(result.stdout).toContain('Added repo "zod"');
    expect(existsSync(join(repoDir("zod"), "zod.ts"))).toBe(true);
  });
});

describe("shelf add flags", () => {
  let remote: Remote;

  beforeEach(async () => {
    remote = await createRemote(tempDir);
  });

  test("--alias names the repo's folder and config entry", async () => {
    const result = await shelf.run(["add", remote.url, "--alias", "my-lib"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Added repo "my-lib"');
    expect(existsSync(join(repoDir("my-lib"), "file.txt"))).toBe(true);
    expect((await storedRepos()).map((r) => r.alias)).toEqual(["my-lib"]);
  });

  test("--pin checks out and stores the pinned ref", async () => {
    const result = await shelf.run(["add", remote.url, "--alias", "lib", "--pin", "tag:v1"]);

    expect(result.exitCode).toBe(0);
    expect(await git(["rev-parse", "HEAD"], repoDir("lib"))).toBe(remote.commits.second);
    expect(await storedRepos()).toMatchObject([
      { alias: "lib", pin: { type: "tag", value: "v1" } },
    ]);
  });

  test("without --depth the clone holds only the latest commit", async () => {
    const result = await shelf.run(["add", remote.url, "--alias", "lib"]);

    expect(result.exitCode).toBe(0);
    expect(await git(["rev-list", "--count", "HEAD"], repoDir("lib"))).toBe("1");
  });

  test("--depth clones that many commits", async () => {
    const result = await shelf.run(["add", remote.url, "--alias", "lib", "--depth", "2"]);

    expect(result.exitCode).toBe(0);
    expect(await git(["rev-list", "--count", "HEAD"], repoDir("lib"))).toBe("2");
  });

  test("--sparse checks out only the listed folders", async () => {
    await publish("acme/mono", {
      "README.md": "# mono",
      "src/index.ts": "export {};",
      "packages/core/core.ts": "export {};",
      "docs/guide.md": "# guide",
    });

    const result = await shelf.run([
      "add",
      "acme/mono",
      "--alias",
      "mono",
      "--sparse",
      "src, packages/core",
    ]);

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(repoDir("mono"), "src", "index.ts"))).toBe(true);
    expect(existsSync(join(repoDir("mono"), "packages", "core", "core.ts"))).toBe(true);
    expect(existsSync(join(repoDir("mono"), "docs"))).toBe(false);
  });
});
