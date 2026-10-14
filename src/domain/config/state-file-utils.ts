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
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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

const errorCode = (error: unknown): string | undefined =>
	error !== null && typeof error === "object" && "code" in error
		? String((error as { code: unknown }).code)
		: undefined;

const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const isProcessAlive = (pid: number): boolean => {
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

/** Is the existing lock file at `lockPath` stale (its owner gone)? */
const isLockStale = async (lockPath: string): Promise<boolean> => {
	let content: string;
	try {
		content = await readFile(lockPath, "utf8");
	} catch (error) {
		// Released between our create attempt and this read: retry at once.
		if (errorCode(error) === "ENOENT") return true;
		throw error;
	}
	const pid = parseLockPid(content);
	if (pid !== undefined) return !isProcessAlive(pid);
	// No PID yet: the owner may be mid-write, or crashed before writing one.
	try {
		const info = await stat(lockPath);
		return Date.now() - info.mtimeMs > EMPTY_LOCK_STALE_MS;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return true;
		throw error;
	}
};

/**
 * Removes a stale lock without racing another process that is taking it over
 * at the same time: the lock is first renamed to a unique name, so only one
 * process gets to remove the file it judged stale.
 */
const takeOverStaleLock = async (lockPath: string): Promise<void> => {
	const claimed = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
	try {
		await rename(lockPath, claimed);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return;
		throw error;
	}
	await rm(claimed, { force: true });
};

/**
 * One try at creating the lock file. "held" means a live process owns it;
 * "stale" means a dead owner's lock was just removed, so try again at once.
 */
const attemptLock = async (lockPath: string): Promise<"acquired" | "held" | "stale"> => {
	try {
		const handle = await open(lockPath, "wx");
		try {
			await handle.writeFile(String(process.pid));
		} finally {
			await handle.close();
		}
		return "acquired";
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw error;
	}
	if (!(await isLockStale(lockPath))) return "held";
	await takeOverStaleLock(lockPath);
	return "stale";
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
				yield* Effect.sleep(Duration.millis(10 + Math.random() * 40));
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
