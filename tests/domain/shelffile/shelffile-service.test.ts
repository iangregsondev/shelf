import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShelffileService } from "../../../src/domain/shelffile/shelffile-service";
import { RepoPin } from "../../../src/domain/config/config-schema";
import type { Shelffile } from "../../../src/domain/shelffile/shelffile-schema";
import { readText, writeText } from "../../helpers/files";
import { PlatformLayer } from "../../helpers/platform";
import { runningAsRoot } from "../../helpers/process";

describe("ShelffileService", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "shelf-shelffile-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const run = <A, E>(effect: Effect.Effect<A, E, ShelffileService>) =>
    Effect.runPromise(
      effect.pipe(Effect.provide(ShelffileService.layer), Effect.provide(PlatformLayer)),
    );

  /** Runs `effect` expecting it to fail, and returns the error. */
  const runError = <A, E>(effect: Effect.Effect<A, E, ShelffileService>) =>
    run(Effect.flip(effect));

  const read = (dir: string) => ShelffileService.use((svc) => svc.read(dir));
  const write = (dir: string, shelffile: Shelffile) =>
    ShelffileService.use((svc) => svc.write(dir, shelffile));
  const possibleAliases = (dir: string) => ShelffileService.use((svc) => svc.possibleAliases(dir));

  describe("read", () => {
    test("fails with ShelffileNotFoundError naming the path when the file is missing", async () => {
      const error = await runError(read(tempDir));
      expect(error._tag).toBe("ShelffileNotFoundError");
      expect(error).toMatchObject({ path: join(tempDir, "shelffile") });
    });

    test.skipIf(runningAsRoot)(
      "fails with ShelffileNotFoundError when the folder cannot be searched",
      async () => {
        const locked = join(tempDir, "locked");
        await mkdir(locked);
        await chmod(locked, 0o000);
        try {
          const error = await runError(read(join(locked, "inner")));
          expect(error._tag).toBe("ShelffileNotFoundError");
          expect(error).toMatchObject({ path: join(locked, "inner", "shelffile") });
        } finally {
          await chmod(locked, 0o755);
        }
      },
    );

    test("returns no entries for an empty file", async () => {
      await writeText(join(tempDir, "shelffile"), "");
      expect(await run(read(tempDir))).toEqual({ entries: [] });
    });

    test("parses a valid shelffile", async () => {
      await writeText(
        join(tempDir, "shelffile"),
        "effect https://github.com/Effect-TS/effect.git pin:branch:main\n",
      );
      const result = await run(read(tempDir));
      expect(result.entries).toEqual([
        {
          alias: "effect",
          url: "https://github.com/Effect-TS/effect.git",
          pin: Option.some(new RepoPin({ type: "branch", value: "main" })),
        },
      ]);
    });

    test("fails with the parser's ShelffileParseError on malformed content", async () => {
      await writeText(join(tempDir, "shelffile"), "only-alias\n");
      const error = await runError(read(tempDir));
      expect(error._tag).toBe("ShelffileParseError");
      expect(error).toMatchObject({
        message: 'Line 1: expected at least "alias url", got "only-alias"',
      });
    });

    test("fails with ShelffileParseError when the shelffile cannot be read", async () => {
      // A folder named shelffile exists but cannot be read as text.
      await mkdir(join(tempDir, "shelffile"));
      const error = await runError(read(tempDir));
      expect(error._tag).toBe("ShelffileParseError");
      expect(error).toMatchObject({
        message: `Failed to read ${join(tempDir, "shelffile")}`,
      });
    });
  });

  describe("possibleAliases", () => {
    test("returns the first word of every non-comment line, even when lines don't parse", async () => {
      await writeText(
        join(tempDir, "shelffile"),
        "# comment\neffect https://github.com/Effect-TS/effect.git\nbroken\nreact url pin:nonsense\n",
      );
      const aliases = await run(possibleAliases(tempDir));
      expect([...aliases].sort()).toEqual(["broken", "effect", "react"]);
    });

    test("fails with ShelffileParseError when the file is missing", async () => {
      const error = await runError(possibleAliases(tempDir));
      expect(error._tag).toBe("ShelffileParseError");
      expect(error).toMatchObject({
        message: `Failed to read ${join(tempDir, "shelffile")}`,
      });
    });
  });

  describe("write", () => {
    test("writes the serialized shelffile, creating a missing folder", async () => {
      const dir = join(tempDir, "nested", "project");
      await run(
        write(dir, {
          entries: [
            {
              alias: "react",
              url: "https://github.com/facebook/react.git",
              pin: Option.some(new RepoPin({ type: "tag", value: "v19.0.0" })),
            },
            { alias: "effect", url: "https://github.com/Effect-TS/effect.git", pin: Option.none() },
          ],
        }),
      );
      expect(await readText(join(dir, "shelffile"))).toBe(
        "react https://github.com/facebook/react.git pin:tag:v19.0.0\n" +
          "effect https://github.com/Effect-TS/effect.git\n",
      );
    });

    test("round-trips through read", async () => {
      const shelffile = {
        entries: [
          {
            alias: "react",
            url: "https://github.com/facebook/react.git",
            pin: Option.some(new RepoPin({ type: "tag", value: "v19.0.0" })),
          },
        ],
      };
      const result = await run(write(tempDir, shelffile).pipe(Effect.andThen(read(tempDir))));
      expect(result).toEqual(shelffile);
    });

    test("fails with ShelffileParseError when the folder cannot be created", async () => {
      // A file stands where the project folder should be.
      const blocker = join(tempDir, "blocker");
      await writeText(blocker, "");
      const error = await runError(write(blocker, { entries: [] }));
      expect(error._tag).toBe("ShelffileParseError");
      expect(error).toMatchObject({
        message: `Failed to write ${join(blocker, "shelffile")}`,
      });
    });
  });
});
