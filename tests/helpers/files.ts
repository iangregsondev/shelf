// File helpers for tests, on node:fs.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Writes `content` to `path`, creating any missing parent directories first. */
export const writeText = async (path: string, content: string): Promise<void> => {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content);
};

/** Reads `path` as UTF-8 text. */
export const readText = (path: string): Promise<string> => readFile(path, "utf8");

/** Reads `path` and parses it as JSON. */
export const readJson = async (path: string): Promise<unknown> =>
	JSON.parse(await readFile(path, "utf8"));
