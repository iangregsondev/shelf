// `shelf list`: an empty shelf and a shelf with reference repos.

import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";
import { createRemote, type Remote } from "../helpers/git-remote";

let shelf: ShelfSandbox;
let tempDir: string;
let remote: Remote;

beforeEach(async () => {
  shelf = await createShelfSandbox();
  tempDir = await mkdtemp(join(tmpdir(), "shelf-list-test-"));
  remote = await createRemote(tempDir);
});

afterEach(async () => {
  await shelf.cleanup();
  await rm(tempDir, { recursive: true, force: true });
});

describe("shelf list", () => {
  test("an empty shelf says how to add a repo", async () => {
    const result = await shelf.run(["list"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("No repos configured. Use `shelf add <url>` to add one.\n");
  });

  test("lists each repo with its url, pin, sync time and path", async () => {
    expect((await shelf.run(["add", remote.url, "--alias", "plain"])).exitCode).toBe(0);
    expect(
      (await shelf.run(["add", remote.url, "--alias", "pinned", "--pin", "branch:feature"]))
        .exitCode,
    ).toBe(0);

    const result = await shelf.run(["list"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(
      new RegExp(
        `^ {2}plain — ${remote.url} \\[\\(default branch\\)\\] \\(synced: \\d{4}-\\S+\\)$`,
      ),
    );
    expect(lines[1]).toBe(`    → ${join(shelf.home, "repos", "plain")}`);
    expect(lines[2]).toMatch(
      new RegExp(`^ {2}pinned — ${remote.url} \\[branch:feature\\] \\(synced: \\d{4}-\\S+\\)$`),
    );
    expect(lines[3]).toBe(`    → ${join(shelf.home, "repos", "pinned")}`);
  });
});
