import { describe, test, expect, beforeEach, afterEach, vi } from "vite-plus/test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
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
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isProcessAlive,
  parseLockPid,
  withStateFileLock,
  writeFileAtomic,
} from "../../../src/domain/config/state-file-store";
import { deadPid, runningAsRoot } from "../../helpers/process";

// Hooks into the store's file-system calls, to stage races between processes
// at exact points. Every hook is cleared after each test.
const fsHooks = vi.hoisted(() => ({
  beforeLstat: undefined as undefined | ((path: string) => Promise<void>),
  afterRename: undefined as undefined | ((from: string, to: string) => Promise<void>),
  beforeRename: undefined as undefined | ((from: string, to: string) => Promise<void>),
  link: undefined as undefined | ((from: string, to: string) => Promise<void>),
  wrapHandle: undefined as undefined | ((handle: FileHandle) => FileHandle),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (path: string) => {
      await fsHooks.beforeLstat?.(path);
      return actual.lstat(path);
    },
    rename: async (from: string, to: string) => {
      await fsHooks.beforeRename?.(from, to);
      await actual.rename(from, to);
      await fsHooks.afterRename?.(from, to);
    },
    link: async (from: string, to: string) => {
      await fsHooks.link?.(from, to);
      return actual.link(from, to);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      return fsHooks.wrapHandle === undefined ? handle : fsHooks.wrapHandle(handle);
    },
  };
});

/** Runs `hook` once, the first time `matches` holds for the call's arguments. */
const once = <Args extends Array<string>>(
  matches: (...args: Args) => boolean,
  hook: (...args: Args) => Promise<void>,
) => {
  let done = false;
  return async (...args: Args): Promise<void> => {
    if (done || !matches(...args)) return;
    done = true;
    await hook(...args);
  };
};

class LockError {
  readonly _tag = "LockError";
  constructor(readonly message: string) {}
}

const onError = (message: string) => new LockError(message);

/** The PID of a process that has already exited. */
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
    fsHooks.beforeLstat = undefined;
    fsHooks.afterRename = undefined;
    fsHooks.beforeRename = undefined;
    fsHooks.link = undefined;
    fsHooks.wrapHandle = undefined;
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

    test("takes over a lock naming this process's own PID, left by an earlier process that had it", async () => {
      // In a container shelf often runs as the same PID every time, so a
      // crashed run's lock can name this process. No fiber here holds it
      // (they take turns first), so it can only be left over.
      await writeFile(lockPath, String(process.pid));
      expect(await run(Effect.succeed("ran"))).toBe("ran");
      expect(await exists(lockPath)).toBe(false);
    }, 5000);

    test("stops waiting at once when interrupted while another live process holds the lock", async () => {
      await writeFile(lockPath, "1");
      const started = Date.now();
      const result = await Effect.runPromise(
        Effect.succeed("ran").pipe(
          withStateFileLock(statePath, onError),
          Effect.timeoutOption("100 millis"),
        ),
      );
      expect(result._tag).toBe("None");
      expect(Date.now() - started).toBeLessThan(2000);
      expect(await readFile(lockPath, "utf8")).toBe("1");
    }, 5000);

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

    /** Runs a no-op under the lock, giving up after `ms`; Some when it got the lock. */
    const runWithin = (ms: number) =>
      Effect.runPromise(
        Effect.succeed("ran").pipe(
          withStateFileLock(statePath, onError),
          Effect.timeoutOption(Duration.millis(ms)),
        ),
      );

    const isClaim = (_from: string, to: string) => to.includes(".stale-");

    test("leaves a fresh lock alone when another process took over the stale lock first", async () => {
      // Two processes see the same stale lock. The other one renames it aside
      // and creates its own lock just before this one renames "the stale lock".
      await writeFile(lockPath, String(deadPid()));
      fsHooks.beforeRename = once(isClaim, async () => {
        await rm(lockPath);
        await writeFile(lockPath, "1");
      });
      const result = await runWithin(300);
      expect(result._tag).toBe("None");
      expect(await readFile(lockPath, "utf8")).toBe("1");
      expect(await readdir(dir)).toEqual(["state.json.lock"]);
    });

    test("leaves a fresh empty lock alone when its owner is mid-write", async () => {
      await writeFile(lockPath, String(deadPid()));
      fsHooks.beforeRename = once(isClaim, async () => {
        await rm(lockPath);
        await writeFile(lockPath, "");
      });
      const result = await runWithin(300);
      expect(result._tag).toBe("None");
      expect(await readFile(lockPath, "utf8")).toBe("");
      expect(await readdir(dir)).toEqual(["state.json.lock"]);
    });

    test("keeps a newer lock when a fresh lock it claimed by mistake can't go back", async () => {
      // After this process claims a fresh lock by mistake, a third process
      // finds no lock and creates one; that newer lock stays in place.
      await writeFile(lockPath, String(deadPid()));
      fsHooks.beforeRename = once(isClaim, async () => {
        await rm(lockPath);
        await writeFile(lockPath, "1");
      });
      // Also PID 1 (always alive); the newline tells the two locks apart.
      fsHooks.afterRename = once(isClaim, () => writeFile(lockPath, "1\n"));
      const result = await runWithin(300);
      expect(result._tag).toBe("None");
      expect(await readFile(lockPath, "utf8")).toBe("1\n");
      expect(await readdir(dir)).toEqual(["state.json.lock"]);
    });

    test("fails through onError when a fresh lock it claimed by mistake can't be put back", async () => {
      await writeFile(lockPath, String(deadPid()));
      fsHooks.beforeRename = once(isClaim, async () => {
        await rm(lockPath);
        await writeFile(lockPath, "1");
      });
      fsHooks.link = () =>
        Promise.reject(
          Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }),
        );
      const exit = await runExit(Effect.succeed("ran"));
      expect(JSON.stringify(exit)).toContain(`Failed to lock ${lockPath}: EPERM`);
    });

    test("tries again when the lock it claimed vanishes from under its unique name", async () => {
      await writeFile(lockPath, String(deadPid()));
      fsHooks.afterRename = once(isClaim, (_from, to) => rm(to));
      expect(await run(Effect.succeed("ran"))).toBe("ran");
      expect(await readdir(dir)).toEqual([]);
    });

    test("fails through onError when the existing lock can't be looked at", async () => {
      await writeFile(lockPath, "1");
      fsHooks.beforeLstat = () =>
        Promise.reject(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }));
      const exit = await runExit(Effect.succeed("ran"));
      expect(JSON.stringify(exit)).toContain(`Failed to lock ${lockPath}: EIO`);
    });

    test("takes the lock at once when the lock is released just after it blocked us", async () => {
      await writeFile(lockPath, "1");
      fsHooks.beforeLstat = once<[string]>(
        (path) => path === lockPath,
        () => rm(lockPath),
      );
      expect(await run(Effect.succeed("ran"))).toBe("ran");
      expect(await readdir(dir)).toEqual([]);
    });

    test("removes its new lock file when writing its PID fails", async () => {
      fsHooks.wrapHandle = (handle) => {
        handle.writeFile = () =>
          Promise.reject(
            Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }),
          );
        return handle;
      };
      const exit = await runExit(Effect.succeed("ran"));
      expect(JSON.stringify(exit)).toContain(`Failed to lock ${lockPath}: ENOSPC`);
      expect(await readdir(dir)).toEqual([]);
    });
  });
});
