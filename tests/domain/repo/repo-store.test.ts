import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirSize, listFolder, pathExists, sameFolder } from "../../../src/domain/repo/repo-store";
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

describe("listFolder", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "shelf-listfolder-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("lists the names directly inside the folder", async () => {
    await writeText(join(dir, "a.txt"), "a");
    await writeText(join(dir, "sub", "b.txt"), "b");
    const names = await Effect.runPromise(listFolder(dir));
    expect([...names].sort()).toEqual(["a.txt", "sub"]);
  });

  test("a missing folder lists nothing rather than failing", async () => {
    expect(await Effect.runPromise(listFolder(join(dir, "missing")))).toEqual([]);
  });
});

describe("pathExists", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "shelf-pathexists-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("is true for a folder or file that is there", async () => {
    await writeText(join(dir, "a.txt"), "a");
    expect(await Effect.runPromise(pathExists(dir))).toBe(true);
    expect(await Effect.runPromise(pathExists(join(dir, "a.txt")))).toBe(true);
  });

  test("is false for a missing path", async () => {
    expect(await Effect.runPromise(pathExists(join(dir, "missing")))).toBe(false);
  });
});

describe("sameFolder", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "shelf-samefolder-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("is true for two paths to the same folder", async () => {
    await mkdir(join(dir, "a"));
    expect(await Effect.runPromise(sameFolder(join(dir, "a"), join(dir, "sub", "..", "a")))).toBe(
      true,
    );
  });

  test("is false for two different folders", async () => {
    await mkdir(join(dir, "a"));
    await mkdir(join(dir, "b"));
    expect(await Effect.runPromise(sameFolder(join(dir, "a"), join(dir, "b")))).toBe(false);
  });

  test("is false when either path is missing", async () => {
    await mkdir(join(dir, "a"));
    expect(await Effect.runPromise(sameFolder(join(dir, "a"), join(dir, "missing")))).toBe(false);
  });
});
