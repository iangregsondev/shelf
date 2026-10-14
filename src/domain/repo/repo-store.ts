// Storage boundary for reference repo folders: file-system reads only.

import * as Effect from "effect/Effect";
import { existsSync } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** Whether anything (file, folder or link) is at `path`. */
export const pathExists = (path: string): Effect.Effect<boolean> =>
  Effect.sync(() => existsSync(path));

/** The names directly inside `dirPath`; empty when it can't be read. */
export const listFolder = (dirPath: string): Effect.Effect<ReadonlyArray<string>> =>
  Effect.tryPromise(() => readdir(dirPath)).pipe(
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );

/**
 * Whether `a` and `b` are the same folder on disk (same device and inode),
 * as two spellings of one name are on a case-insensitive file system.
 * False when either is missing.
 */
export const sameFolder = (a: string, b: string): Effect.Effect<boolean> =>
  Effect.tryPromise(async () => {
    const [sa, sb] = await Promise.all([stat(a, { bigint: true }), stat(b, { bigint: true })]);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  }).pipe(Effect.orElseSucceed(() => false));

const walkSize = async (dirPath: string): Promise<number> => {
  let total = 0;
  const stack = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    const entries = await readdir(current, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else {
        files.push(fullPath);
      }
    }
    const sizes = await Promise.all(files.map(async (file) => (await lstat(file)).size));
    for (const size of sizes) {
      total += size;
    }
  }
  return total;
};

/** The total bytes of every file under `dirPath`; 0 when it can't be read. */
export const dirSize = (dirPath: string): Effect.Effect<number> =>
  Effect.tryPromise(() => walkSize(dirPath)).pipe(Effect.orElseSucceed(() => 0));
