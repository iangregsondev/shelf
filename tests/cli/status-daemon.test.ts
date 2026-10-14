// `shelf status` while the daemon is running: it still reports the shelf.

import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopDaemonIn } from "../helpers/daemon";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";
import { createRemote, type Remote } from "../helpers/git-remote";

let shelf: ShelfSandbox;
let tempDir: string;
let remote: Remote;

beforeEach(async () => {
  shelf = await createShelfSandbox();
  tempDir = await mkdtemp(join(tmpdir(), "shelf-status-daemon-test-"));
  remote = await createRemote(tempDir);
});

afterEach(async () => {
  await stopDaemonIn(shelf.home);
  await shelf.cleanup();
  await rm(tempDir, { recursive: true, force: true });
});

describe("shelf status with a running daemon", () => {
  test("reports each repo as usual", async () => {
    expect((await shelf.run(["add", remote.url, "--alias", "lib"])).exitCode).toBe(0);
    expect((await shelf.run(["daemon", "start"])).exitCode).toBe(0);

    const result = await shelf.run(["status"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`  lib — ${remote.url}`);
    expect(result.stdout).toMatch(/Pin: \(default branch\) {2}\| {2}Synced: \S+ {2}\| {2}Size:/);
    expect(result.stdout).toContain("Referenced by: manual");
  });
});
