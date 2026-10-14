import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirSize } from "../../../src/domain/repo/repo-store";
import { writeText } from "../../helpers/files";

describe("dirSize", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "shelf-dirsize-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("an empty folder is 0 bytes", async () => {
    expect(await Effect.runPromise(dirSize(dir))).toBe(0);
  });

  test("adds up the bytes of every file in nested folders", async () => {
    await writeText(join(dir, "a.txt"), "12345");
    await mkdir(join(dir, "sub", "deeper"), { recursive: true });
    await writeText(join(dir, "sub", "b.txt"), "123");
    await writeText(join(dir, "sub", "deeper", "c.txt"), "1234567890");
    expect(await Effect.runPromise(dirSize(dir))).toBe(18);
  });

  test("a missing folder is 0 bytes rather than an error", async () => {
    expect(await Effect.runPromise(dirSize(join(dir, "missing")))).toBe(0);
  });

  test("a broken symlink does not zero out the rest of the folder", async () => {
    await writeText(join(dir, "a.txt"), "12345");
    await symlink(join(dir, "nowhere"), join(dir, "dangling"));
    const size = await Effect.runPromise(dirSize(dir));
    expect(size).toBeGreaterThanOrEqual(5);
  });
});
