import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import { join } from "node:path";
import { stopDaemonIn } from "../helpers/daemon";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";
import { readJson, writeText } from "../helpers/files";

let shelf: ShelfSandbox;
let daemonPids: number[] = [];
const runShelf = (args: string[], cwd?: string) => shelf.run(args, { cwd });

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The PID daemon.json records, remembered so afterEach kills it even if the record changes. */
const recordedPid = async (): Promise<number> => {
  const { pid } = (await readJson(join(shelf.home, "daemon.json"))) as { pid: number };
  daemonPids.push(pid);
  return pid;
};

beforeEach(async () => {
  shelf = await createShelfSandbox();
  daemonPids = [];
});

afterEach(async () => {
  try {
    await stopDaemonIn(shelf.home, daemonPids);
  } finally {
    await shelf.cleanup();
  }
});

describe("daemon command", () => {
  test("daemon status reports a daemon that was never started as not running", async () => {
    const result = await runShelf(["daemon", "status"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("Daemon is not running");
  });

  test("daemon stop with no daemon fails with a clean message", async () => {
    const result = await runShelf(["daemon", "stop"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.trim()).toBe("No daemon is currently running.");
  });
});

describe("daemon logs", () => {
  const writeLog = (count: number) =>
    writeText(
      join(shelf.home, "daemon.log"),
      Array.from({ length: count }, (_, i) => `line ${i + 1}\n`).join(""),
    );

  test("says so when there is no log", async () => {
    const result = await runShelf(["daemon", "logs"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("No daemon logs found.");
  });

  test("without --lines prints the last 50 lines", async () => {
    await writeLog(60);
    const result = await runShelf(["daemon", "logs"]);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(50);
    expect(lines[0]).toBe("line 11");
    expect(lines.at(-1)).toBe("line 60");
  });

  test("--lines prints that many lines from the end", async () => {
    await writeLog(10);
    const result = await runShelf(["daemon", "logs", "--lines", "3"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trimEnd().split("\n")).toEqual(["line 8", "line 9", "line 10"]);
  });

  test("--lines larger than the log prints the whole log", async () => {
    await writeLog(2);
    const result = await runShelf(["daemon", "logs", "--lines", "10"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trimEnd().split("\n")).toEqual(["line 1", "line 2"]);
  });
});
