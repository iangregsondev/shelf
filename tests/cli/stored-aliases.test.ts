// An alias in config.json may have been hand-edited into something that is
// not a single safe folder name, such as `../outside`. Shelf must refuse to
// act on such a repo, with a clear error, and never touch the path it names.

import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";
import { writeText } from "../helpers/files";

const BAD = "../outside";
const URL = "https://example.com/outside.git";

let shelf: ShelfSandbox;
/** The folder `repos/../outside` points at; it must survive every command. */
let outside: string;

beforeEach(async () => {
  shelf = await createShelfSandbox();
  outside = join(shelf.home, "outside");
  await mkdir(outside, { recursive: true });
  await writeText(join(outside, "precious.txt"), "keep me");
  await mkdir(join(shelf.home, "repos"), { recursive: true });
  await writeText(
    join(shelf.home, "config.json"),
    JSON.stringify({
      version: 1,
      syncIntervalMinutes: 60,
      repos: [{ url: URL, alias: BAD, addedAt: "2026-01-01T00:00:00.000Z" }],
    }),
  );
});

afterEach(async () => {
  await shelf.cleanup();
});

const expectRefused = (result: { exitCode: number; stderr: string }): void => {
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(`Invalid alias "${BAD}"`);
  expect(existsSync(join(outside, "precious.txt"))).toBe(true);
};

describe("a stored alias that breaks the alias rule", () => {
  test.each([
    ["remove by alias", ["remove", BAD]],
    ["remove by URL", ["remove", URL]],
    ["update one repo", ["update", BAD]],
    ["update every repo", ["update"]],
    ["prune --force", ["prune", "--force"]],
    ["pin", ["pin", BAD, "branch:main"]],
    ["alias", ["alias", BAD, "fine"]],
  ])("%s refuses it and leaves the path alone", async (_, args) => {
    expectRefused(await shelf.run(args));
  });
});
