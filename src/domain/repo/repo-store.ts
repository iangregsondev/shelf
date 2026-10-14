// Storage boundary for reference repo folders: file-system reads only.

import * as Effect from "effect/Effect";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** Whether anything (file, folder or link) is at `path`. */
export const pathExists = (path: string): Effect.Effect<boolean> =>
	Effect.sync(() => existsSync(path));

/** The names directly inside `dirPath`; empty when it can't be read. */
export const listFolder = (dirPath: string): Effect.Effect<ReadonlyArray<string>> =>
	Effect.tryPromise(() => readdir(dirPath)).pipe(
		Effect.orElseSucceed((): ReadonlyArray<string> => []),
	);

/** The total bytes of every file under `dirPath`; 0 when it can't be read. */
export const dirSize = (dirPath: string): Effect.Effect<number> =>
	Effect.try({
		try: () => {
			let total = 0;
			const stack = [dirPath];
			while (stack.length > 0) {
				const current = stack.pop() as string;
				const entries = readdirSync(current, { withFileTypes: true });
				for (const entry of entries) {
					const fullPath = join(current, entry.name);
					if (entry.isDirectory()) {
						stack.push(fullPath);
					} else {
						total += lstatSync(fullPath).size;
					}
				}
			}
			return total;
		},
		catch: () => 0,
	}).pipe(Effect.orElseSucceed(() => 0));
