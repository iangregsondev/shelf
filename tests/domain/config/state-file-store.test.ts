import { describe, test, expect, beforeEach, afterEach, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isProcessAlive,
  parseLockPid,
  withStateFileLock,
  writeFileAtomic,
} from "../../../src/domain/config/state-file-store";
import { runningAsRoot } from "../../helpers/process";

class LockError {
  readonly _tag = "LockError";
  constructor(readonly message: string) {}
}

const onError = (message: string) => new LockError(message);

/** The PID of a process that has already exited. */
const deadPid = (): number => {
  const result = spawnSync(process.execPath, ["-e", ""]);
  return result.pid;
};

const exists = (path: string): Promise<boolean> =>
  readFile(path).then(
    () => true,
    () => false,
  );

describe("parseLockPid", () => {
  test("reads the owner PID", () => {
    expect(parseLockPid("4242")).toBe(4242);
    expect(parseLockPid("4242\n")).toBe(4242);
  });

  test("gives undefined when the lock holds no PID yet or garbage", () => {
    expect(parseLockPid("")).toBeUndefined();
    expect(parseLockPid("0")).toBeUndefined();
    expect(parseLockPid("-1")).toBeUndefined();
    expect(parseLockPid("12abc")).toBeUndefined();
  });
});

describe("isProcessAlive", () => {
  test("is true for this process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test("is false for a process that has exited", () => {
    expect(isProcessAlive(deadPid())).toBe(false);
  });

  test("is true for a live process owned by another user", () => {
    // PID 1 (launchd or init) runs as root, so signalling it gives EPERM.
    expect(isProcessAlive(1)).toBe(true);
  });
});

describe("state file store on disk", () => {
  let dir: string;
  let statePath: string;
  let lockPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "shelf-state-file-"));
    statePath = join(dir, "state.json");
    lockPath = `${statePath}.lock`;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await chmod(dir, 0o700);
    await rm(dir, { recursive: true, force: true });
  });

  describe("writeFileAtomic", () => {
    test("writes the content, replacing what was there, and leaves no temp file", async () => {
      await writeFile(statePath, "old");
      await writeFileAtomic(statePath, "new content");
      expect(await readFile(statePath, "utf8")).toBe("new content");
      expect(await readdir(dir)).toEqual(["state.json"]);
    });

    test("creates the file when nothing is there", async () => {
      await writeFileAtomic(statePath, "{}");
      expect(await readFile(statePath, "utf8")).toBe("{}");
    });

    test("fails and removes its temp file when the rename into place fails", async () => {
      await mkdir(join(statePath, "inside"), { recursive: true });
      await expect(writeFileAtomic(statePath, "x")).rejects.toThrow();
      expect(await readdir(dir)).toEqual(["state.json"]);
    });

    test("fails when the folder does not exist", async () => {
      await expect(writeFileAtomic(join(dir, "missing", "state.json"), "x")).rejects.toThrow(
        /ENOENT/,
      );
      expect(await readdir(dir)).toEqual([]);
    });
  });

  describe("withStateFileLock", () => {
    const run = <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.runPromise(effect.pipe(withStateFileLock(statePath, onError)));

    const runExit = <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.runPromiseExit(effect.pipe(withStateFileLock(statePath, onError)));

    test("holds a lock file with this PID while the effect runs, and removes it after", async () => {
      const seen = await run(Effect.promise(() => readFile(lockPath, "utf8")));
      expect(seen).toBe(String(process.pid));
      expect(await exists(lockPath)).toBe(false);
    });

    test("gives the effect's result", async () => {
      expect(await run(Effect.succeed(42))).toBe(42);
    });

    test("passes on the effect's failure and still releases the lock", async () => {
      const exit = await runExit(Effect.fail("nope"));
      expect(exit._tag).toBe("Failure");
      expect(JSON.stringify(exit)).toContain("nope");
      expect(await exists(lockPath)).toBe(false);
    });

    test("creates the state file's folder when it is missing", async () => {
      statePath = join(dir, "nested", "deeper", "state.json");
      lockPath = `${statePath}.lock`;
      expect(await run(Effect.promise(() => exists(lockPath)))).toBe(true);
    });

    test("runs fibers in this process one at a time", async () => {
      const order: Array<string> = [];
      const step = (name: string) =>
        Effect.gen(function* () {
          order.push(`${name}:start`);
          yield* Effect.sleep("20 millis");
          order.push(`${name}:end`);
        }).pipe(withStateFileLock(statePath, onError));
      await Effect.runPromise(
        Effect.all([step("a"), step("b"), step("c")], { concurrency: "unbounded" }),
      );
      expect(order).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
    });

    test("takes over a lock left by a process that has exited", async () => {
      await writeFile(lockPath, String(deadPid()));
      const seen = await run(Effect.promise(() => readFile(lockPath, "utf8")));
      expect(seen).toBe(String(process.pid));
      expect(await readdir(dir)).toEqual([]);
    });

    test("takes over an empty lock file older than five seconds", async () => {
      await writeFile(lockPath, "");
      const old = new Date(Date.now() - 10_000);
      await utimes(lockPath, old, old);
      const seen = await run(Effect.promise(() => readFile(lockPath, "utf8")));
      expect(seen).toBe(String(process.pid));
    });

    test("takes over a lock entry that points at nothing", async () => {
      // A dangling symlink blocks creating the lock but reads as missing,
      // as if the owner released it between the two steps.
      await symlink(join(dir, "gone"), lockPath);
      const seen = await run(Effect.promise(() => readFile(lockPath, "utf8")));
      expect(seen).toBe(String(process.pid));
      expect(await readdir(dir)).toEqual([]);
    });

    test("waits for a live process's lock to be released", async () => {
      // PID 1 is always alive, so this lock is held until the file goes.
      await writeFile(lockPath, "1");
      setTimeout(() => void rm(lockPath), 150);
      const started = Date.now();
      const seen = await run(Effect.promise(() => readFile(lockPath, "utf8")));
      expect(seen).toBe(String(process.pid));
      expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    });

    test("waits on a fresh empty lock file, whose owner may be mid-write", async () => {
      await writeFile(lockPath, "");
      setTimeout(() => void rm(lockPath), 150);
      const started = Date.now();
      await run(Effect.void);
      expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    });

    test("gives up after 30 seconds while another live process holds the lock", async () => {
      await writeFile(lockPath, "1");
      vi.useFakeTimers({ toFake: ["Date"] });
      // Date stands still, so jump it past 30s again and again: whenever the
      // store sets its deadline, the next jump passes it, however slow the run.
      const jumps = setInterval(() => vi.setSystemTime(Date.now() + 31_000), 20);
      const exit = await runExit(Effect.succeed("ran")).finally(() => clearInterval(jumps));
      expect(exit._tag).toBe("Failure");
      expect(JSON.stringify(exit)).toContain(
        `Failed to lock ${lockPath}: timed out waiting for another shelf process`,
      );
      expect(await readFile(lockPath, "utf8")).toBe("1");
    });

    test("leaves a lock that another process took over while the effect ran", async () => {
      await run(Effect.promise(() => writeFile(lockPath, "1")));
      expect(await readFile(lockPath, "utf8")).toBe("1");
    });

    test("releases cleanly when the lock file vanished while the effect ran", async () => {
      expect(await run(Effect.promise(() => rm(lockPath)).pipe(Effect.as("ok")))).toBe("ok");
      expect(await exists(lockPath)).toBe(false);
    });

    test("fails through onError when the folder can't be created", async () => {
      await writeFile(join(dir, "file"), "");
      statePath = join(dir, "file", "state.json");
      lockPath = `${statePath}.lock`;
      const exit = await runExit(Effect.succeed("ran"));
      expect(exit._tag).toBe("Failure");
      expect(JSON.stringify(exit)).toContain(`Failed to lock ${lockPath}: `);
      expect(JSON.stringify(exit)).toContain("LockError");
    });

    test.skipIf(runningAsRoot)(
      "fails through onError when the lock file can't be created",
      async () => {
        await chmod(dir, 0o500);
        const exit = await runExit(Effect.succeed("ran"));
        expect(JSON.stringify(exit)).toContain(`Failed to lock ${lockPath}: EACCES`);
      },
    );

    test("fails through onError when the existing lock can't be read", async () => {
      await mkdir(lockPath);
      const exit = await runExit(Effect.succeed("ran"));
      expect(JSON.stringify(exit)).toContain(`Failed to lock ${lockPath}: EISDIR`);
    });

    test.skipIf(runningAsRoot)(
      "fails through onError when a stale lock can't be taken over",
      async () => {
        await writeFile(lockPath, String(deadPid()));
        await chmod(dir, 0o500);
        const exit = await runExit(Effect.succeed("ran"));
        expect(JSON.stringify(exit)).toContain(`Failed to lock ${lockPath}: EACCES`);
        await chmod(dir, 0o700);
        expect(await exists(lockPath)).toBe(true);
      },
    );
  });
});
