// `shelf daemon stop` lets the daemon finish the sync step it is on. A `git`
// shim on PATH makes every fetch slow, so the stop lands mid-sync.

import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { stopDaemonIn } from "../helpers/daemon";
import { createRemote, git, type Remote } from "../helpers/git-remote";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";
import { readJson, readText, writeText } from "../helpers/files";
import { setTimeout as sleep } from "node:timers/promises";

let tempDir: string;
let shimDir: string;
let shelf: ShelfSandbox;
let remote: Remote;
let daemonPid: number | undefined;

/** The first executable `command` on PATH, like `which`. */
const which = (command: string): string | undefined =>
  (process.env["PATH"] ?? "")
    .split(delimiter)
    .filter((dir) => dir !== "")
    .map((dir) => join(dir, command))
    .find((path) => {
      try {
        accessSync(path, constants.X_OK);
        return statSync(path).isFile();
      } catch {
        return false;
      }
    });

const realGit = which("git") ?? "/usr/bin/git";

/** Puts a `git` on PATH that sleeps `seconds` before each fetch and leaves marker files. */
const installGitShim = async (seconds: number): Promise<void> => {
  const script = [
    "#!/bin/sh",
    'if [ "$1" = fetch ]; then',
    `  touch "${shimDir}/fetch-started"`,
    `  sleep ${seconds}`,
    `  "${realGit}" "$@"`,
    "  status=$?",
    `  touch "${shimDir}/fetch-done"`,
    "  exit $status",
    "fi",
    `exec "${realGit}" "$@"`,
  ].join("\n");
  await writeText(join(shimDir, "git"), `${script}\n`);
  await chmod(join(shimDir, "git"), 0o755);
};

const waitFor = async (check: () => boolean, ms = 10_000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(50);
  }
  return false;
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readConfig = async (): Promise<{ repos: Array<{ alias: string; lastSyncedAt?: string }> }> =>
  (await readJson(join(shelf.home, "config.json"))) as {
    repos: Array<{ alias: string; lastSyncedAt?: string }>;
  };

/** Adds `lib`, pushes a new tip, starts the daemon and waits until it is mid-fetch. */
const startMidSync = async (shimSeconds: number, extraEnv: Record<string, string> = {}) => {
  shelf = await createShelfSandbox({}, { PATH: `${shimDir}:${process.env["PATH"]}`, ...extraEnv });
  await installGitShim(shimSeconds);
  expect((await shelf.run(["add", remote.url, "--alias", "lib"])).exitCode).toBe(0);
  const syncedAtAdd = (await readConfig()).repos[0]?.lastSyncedAt;
  const tip = await remote.commit("main", "fourth");
  const start = await shelf.run(["daemon", "start"]);
  expect(start.exitCode).toBe(0);
  daemonPid = ((await readJson(join(shelf.home, "daemon.json"))) as { pid: number }).pid;
  expect(await waitFor(() => existsSync(join(shimDir, "fetch-started")))).toBe(true);
  return { syncedAtAdd, tip };
};

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "shelf-graceful-"));
  shimDir = join(tempDir, "shim");
  await mkdir(shimDir);
  remote = await createRemote(tempDir);
  daemonPid = undefined;
});

afterEach(async () => {
  try {
    await stopDaemonIn(shelf.home, daemonPid === undefined ? [] : [daemonPid]);
    await shelf.cleanup();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("daemon stop mid-sync", () => {
  test("lets the current sync step finish, then the daemon removes its state file", async () => {
    const { syncedAtAdd, tip } = await startMidSync(2);

    const stop = await shelf.run(["daemon", "stop"]);

    expect(stop.exitCode).toBe(0);
    expect(stop.stdout).toContain("Daemon stopped");
    expect(existsSync(join(shimDir, "fetch-done"))).toBe(true);
    expect(await git(["rev-parse", "HEAD"], join(shelf.home, "repos", "lib"))).toBe(tip);
    expect((await readConfig()).repos[0]?.lastSyncedAt).not.toBe(syncedAtAdd);
    expect(existsSync(join(shelf.home, "daemon.json"))).toBe(false);
    expect(await readText(join(shelf.home, "daemon.log"))).toContain("Sync cycle complete");
  }, 30_000);

  test("never kills a daemon still mid-step: reports it and exits 1, leaving it running", async () => {
    await startMidSync(5, { SHELF_DAEMON_STOP_TIMEOUT_MS: "500" });

    const stop = await shelf.run(["daemon", "stop"]);

    expect(stop.exitCode).toBe(1);
    expect(stop.stderr).toContain("still finishing its current step");
    expect(isAlive(daemonPid!)).toBe(true);
    expect(existsSync(join(shelf.home, "daemon.json"))).toBe(true);
  }, 30_000);
});
