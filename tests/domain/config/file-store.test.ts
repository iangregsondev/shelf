import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { FileSystem } from "effect/FileSystem";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileIfExists, readJsonIfExists } from "../../../src/domain/config/file-store";
import { PlatformLayer } from "../../helpers/platform";
import { runningAsRoot } from "../../helpers/process";

const withFs = <A, E>(use: (fs: FileSystem) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* use(yield* FileSystem);
    }).pipe(Effect.provide(PlatformLayer)),
  );

describe("file store", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "shelf-file-store-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("readFileIfExists", () => {
    test("gives None when nothing is at the path", async () => {
      expect(await withFs((fs) => readFileIfExists(fs, join(dir, "missing.txt")))).toEqual(
        Option.none(),
      );
    });

    test("gives the file's text", async () => {
      await writeFile(join(dir, "notes.txt"), "hello\n");
      expect(await withFs((fs) => readFileIfExists(fs, join(dir, "notes.txt")))).toEqual(
        Option.some("hello\n"),
      );
    });

    test("fails at the read stage when the path can't be read as a file", async () => {
      await mkdir(join(dir, "folder"));
      const error = await withFs((fs) =>
        readFileIfExists(fs, join(dir, "folder")).pipe(Effect.flip),
      );
      expect(error._tag).toBe("StoredFileReadError");
      expect(error.stage).toBe("read");
      expect(error.path).toBe(join(dir, "folder"));
    });

    test.skipIf(runningAsRoot)(
      "fails at the check stage when it can't tell whether the file is there",
      async () => {
        const locked = join(dir, "locked");
        await mkdir(locked);
        await chmod(locked, 0o000);
        try {
          const error = await withFs((fs) =>
            readFileIfExists(fs, join(locked, "state.json")).pipe(Effect.flip),
          );
          expect(error._tag).toBe("StoredFileReadError");
          expect(error.stage).toBe("check");
          expect(error.path).toBe(join(locked, "state.json"));
        } finally {
          await chmod(locked, 0o700);
        }
      },
    );

    test("gives an empty file as empty text", async () => {
      await writeFile(join(dir, "empty.txt"), "");
      expect(await withFs((fs) => readFileIfExists(fs, join(dir, "empty.txt")))).toEqual(
        Option.some(""),
      );
    });
  });

  describe("readJsonIfExists", () => {
    test("gives None when nothing is at the path", async () => {
      expect(await withFs((fs) => readJsonIfExists(fs, join(dir, "missing.json")))).toEqual(
        Option.none(),
      );
    });

    test("gives the parsed JSON", async () => {
      await writeFile(join(dir, "state.json"), '{"pid": 42, "names": ["a"]}');
      expect(await withFs((fs) => readJsonIfExists(fs, join(dir, "state.json")))).toEqual(
        Option.some({ pid: 42, names: ["a"] }),
      );
    });

    test("fails at the parse stage on malformed JSON", async () => {
      await writeFile(join(dir, "broken.json"), "{not json");
      const error = await withFs((fs) =>
        readJsonIfExists(fs, join(dir, "broken.json")).pipe(Effect.flip),
      );
      expect(error._tag).toBe("StoredFileReadError");
      expect(error.stage).toBe("parse");
    });

    test("fails at the parse stage on an empty file", async () => {
      await writeFile(join(dir, "empty.json"), "");
      const error = await withFs((fs) =>
        readJsonIfExists(fs, join(dir, "empty.json")).pipe(Effect.flip),
      );
      expect(error.stage).toBe("parse");
      expect(error.path).toBe(join(dir, "empty.json"));
    });

    test("passes on a read failure", async () => {
      await mkdir(join(dir, "folder.json"));
      const error = await withFs((fs) =>
        readJsonIfExists(fs, join(dir, "folder.json")).pipe(Effect.flip),
      );
      expect(error.stage).toBe("read");
    });
  });
});
