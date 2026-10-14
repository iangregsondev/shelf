// Safe read-modify-write for shelf state files (config.json, registry.json).
//
// `withStateFileLock` holds two locks around a read, apply and save:
// - an in-process semaphore per file, so fibers in one process take turns;
// - a lock file next to the state file (`<file>.lock`, created with O_EXCL and
//   holding the owner's PID), so separate processes take turns. A lock whose
//   PID is no longer running is stale and is taken over.
// Saves write a uniquely named temp file and rename it into place, so a crash
// mid-save never leaves a half-written state file.

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { link, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { errorCode } from "./config-utils";

/** How long to wait for another process's lock before giving up. */
const LOCK_TIMEOUT_MS = 30_000;
/** A lock file with no readable PID older than this is treated as stale. */
const EMPTY_LOCK_STALE_MS = 5000;

const semaphores = new Map<string, Semaphore.Semaphore>();

const semaphoreFor = (path: string): Semaphore.Semaphore => {
  let semaphore = semaphores.get(path);
  if (semaphore === undefined) {
    semaphore = Semaphore.makeUnsafe(1);
    semaphores.set(path, semaphore);
  }
  return semaphore;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Whether a process with this PID exists (even one owned by another user). */
export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return errorCode(error) === "EPERM";
  }
};

/** Parses a lock file's content into the owning PID, or undefined if it holds none. */
export const parseLockPid = (content: string): number | undefined => {
  const trimmed = content.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const pid = Number(trimmed);
  return pid > 0 ? pid : undefined;
};

/**
 * What a lock entry looked like: which file it was and what it held. Two
 * snapshots that match are the same lock, not a newer one in its place.
 */
interface LockSnapshot {
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
  /** The lock's content; undefined when the entry points at nothing (a dangling link). */
  readonly content: string | undefined;
}

/** Snapshots the lock entry at `path`, or undefined when there is none. */
const snapshotLock = async (path: string): Promise<LockSnapshot | undefined> => {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  let content: string | undefined;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  return { dev: info.dev, ino: info.ino, mtimeMs: info.mtimeMs, content };
};

const sameLock = (a: LockSnapshot, b: LockSnapshot): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.content === b.content;

/** Is this lock stale (its owner gone)? */
const isLockStale = (lock: LockSnapshot): boolean => {
  // Points at nothing, as if released between our create attempt and the read.
  if (lock.content === undefined) return true;
  const pid = parseLockPid(lock.content);
  // Fibers in this process take turns before touching the lock file, so a lock
  // naming this PID was left by an earlier process that had the same PID.
  if (pid !== undefined) return pid === process.pid || !isProcessAlive(pid);
  // No PID yet: the owner may be mid-write, or crashed before writing one.
  return Date.now() - lock.mtimeMs > EMPTY_LOCK_STALE_MS;
};

/**
 * Removes the stale lock `seen` without racing another process that is taking
 * it over at the same time: the lock is first renamed to a unique name, so only
 * one process gets the file. If what it got is not `seen` (another process took
 * the stale lock over first and made a fresh one), it puts that lock back and
 * gives "held". Gives "stale" when the stale lock is gone, to try again at once.
 */
const takeOverStaleLock = async (
  lockPath: string,
  seen: LockSnapshot,
): Promise<"held" | "stale"> => {
  const claimed = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(lockPath, claimed);
  } catch (error) {
    /* v8 ignore next -- only when another process takes over the same stale lock first */
    if (errorCode(error) === "ENOENT") return "stale";
    throw error;
  }
  const got = await snapshotLock(claimed);
  // Gone from under its unique name: nothing to put back, so try again.
  if (got === undefined) return "stale";
  if (sameLock(got, seen)) {
    await rm(claimed, { force: true });
    return "stale";
  }
  // A live lock, claimed by mistake: put it back without replacing any lock
  // made since (link fails if one exists, where rename would overwrite it).
  try {
    await link(claimed, lockPath);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  await rm(claimed, { force: true });
  return "held";
};

/** Creates the lock file holding this PID; false if a lock file already exists. */
const createLock = async (lockPath: string): Promise<boolean> => {
  let handle: FileHandle;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(String(process.pid));
  } catch (error) {
    // Leave no empty lock behind for others to wait on.
    await handle.close();
    await rm(lockPath, { force: true });
    throw error;
  }
  await handle.close();
  return true;
};

/**
 * One try at creating the lock file. "held" means a live process owns it;
 * "stale" means a dead owner's lock was just removed, so try again at once.
 */
const attemptLock = async (lockPath: string): Promise<"acquired" | "held" | "stale"> => {
  if (await createLock(lockPath)) return "acquired";
  const lock = await snapshotLock(lockPath);
  // Released between our create attempt and the snapshot: retry at once.
  if (lock === undefined) return "stale";
  if (!isLockStale(lock)) return "held";
  return takeOverStaleLock(lockPath, lock);
};

const acquireLockFile = <E>(
  lockPath: string,
  onError: (message: string) => E,
): Effect.Effect<void, E> =>
  Effect.gen(function* () {
    const fail = (error: unknown): E =>
      onError(`Failed to lock ${lockPath}: ${errorMessage(error)}`);
    yield* Effect.tryPromise({
      try: () => mkdir(dirname(lockPath), { recursive: true }),
      catch: fail,
    });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      const attempt = yield* Effect.tryPromise({ try: () => attemptLock(lockPath), catch: fail });
      if (attempt === "acquired") return;
      if (attempt === "held") {
        if (Date.now() > deadline) {
          return yield* Effect.fail(fail(new Error("timed out waiting for another shelf process")));
        }
        // This runs as acquireUseRelease's uninterruptible acquire; no lock is
        // held while waiting, so let an interrupt (Ctrl+C) end the wait.
        yield* Effect.interruptible(Effect.sleep(Duration.millis(10 + Math.random() * 40)));
      }
    }
  });

const releaseLockFile = async (lockPath: string): Promise<void> => {
  try {
    const pid = parseLockPid(await readFile(lockPath, "utf8"));
    if (pid === process.pid) await rm(lockPath, { force: true });
  } catch {
    // Already gone: nothing to release.
  }
};

/** Writes `content` to a uniquely named temp file next to `path`, then renames it into place. */
export const writeFileAtomic = async (path: string, content: string): Promise<void> => {
  const tmpPath = `${path}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, content);
    await rename(tmpPath, path);
  } catch (error) {
    await rm(tmpPath, { force: true });
    throw error;
  }
};

/**
 * Runs `effect` while holding both locks for the state file at `path`.
 * Lock failures are reported through `onError`.
 */
export const withStateFileLock =
  <E2>(path: string, onError: (message: string) => E2) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | E2, R> => {
    const lockPath = `${path}.lock`;
    const locked = Effect.acquireUseRelease(
      acquireLockFile(lockPath, onError),
      () => effect,
      () => Effect.promise(() => releaseLockFile(lockPath)),
    );
    return semaphoreFor(path).withPermits(1)(locked);
  };
