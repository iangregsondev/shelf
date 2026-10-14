import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { chmod, mkdtemp, rm, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultConfig,
  decodeConfig,
  encodeConfig,
  ShelfConfig,
  RepoPin,
  makeRepoEntry,
} from "../../../src/domain/config/config-schema";
import * as Option from "effect/Option";
import { ConfigService } from "../../../src/domain/config/config-service";
import { readJson, readText, writeText } from "../../helpers/files";
import { PlatformLayer } from "../../helpers/platform";
import { runningAsRoot } from "../../helpers/process";

describe("ConfigService", () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "shelf-config-test-"));
    configPath = join(tempDir, "config.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("defaultConfig", () => {
    test("has correct defaults", () => {
      expect(defaultConfig.version).toBe(1);
      expect(defaultConfig.syncIntervalMinutes).toBe(60);
      expect(defaultConfig.repos).toEqual([]);
    });
  });

  describe("encodeConfig / decodeConfig", () => {
    test("round-trips a valid config", () => {
      const encoded = encodeConfig(defaultConfig);
      const decoded = decodeConfig(encoded);
      expect(decoded.version).toBe(1);
      expect(decoded.syncIntervalMinutes).toBe(60);
      expect(decoded.repos).toEqual([]);
    });

    test("decodes valid JSON config", () => {
      const raw = {
        version: 1,
        syncIntervalMinutes: 30,
        repos: [],
      };
      const decoded = decodeConfig(raw);
      expect(decoded.syncIntervalMinutes).toBe(30);
    });

    test("throws on invalid schema", () => {
      expect(() => decodeConfig({ version: 2, repos: [] })).toThrow();
    });

    test("throws on corrupt data", () => {
      expect(() => decodeConfig("not json")).toThrow();
    });

    test("decodes config with repos", () => {
      const raw = {
        version: 1,
        syncIntervalMinutes: 60,
        repos: [
          {
            url: "https://github.com/test/repo.git",
            alias: "test-repo",
            addedAt: "2026-01-01T00:00:00Z",
            pin: { type: "branch", value: "main" },
            lastSyncedAt: "2026-01-01T12:00:00Z",
          },
        ],
      };
      const decoded = decodeConfig(raw);
      expect(decoded.repos.length).toBe(1);
      expect(decoded.repos[0]!.alias).toBe("test-repo");
      expect(Option.isSome(decoded.repos[0]!.pin)).toBe(true);
      expect(Option.isSome(decoded.repos[0]!.lastSyncedAt)).toBe(true);
    });

    test("round-trips config with depth and sparse fields", () => {
      const raw = {
        version: 1,
        syncIntervalMinutes: 60,
        repos: [
          {
            url: "https://github.com/test/repo.git",
            alias: "test-repo",
            addedAt: "2026-01-01T00:00:00Z",
            depth: 1,
            sparse: ["src", "packages/core"],
          },
        ],
      };
      const decoded = decodeConfig(raw);
      expect(decoded.repos.length).toBe(1);
      expect(Option.isSome(decoded.repos[0]!.depth)).toBe(true);
      if (Option.isSome(decoded.repos[0]!.depth)) {
        expect(decoded.repos[0]!.depth.value).toBe(1);
      }
      expect(Option.isSome(decoded.repos[0]!.sparse)).toBe(true);
      if (Option.isSome(decoded.repos[0]!.sparse)) {
        expect(decoded.repos[0]!.sparse.value).toEqual(["src", "packages/core"]);
      }
      const reEncoded = encodeConfig(decoded);
      const reDecoded = decodeConfig(reEncoded);
      expect(Option.isSome(reDecoded.repos[0]!.depth)).toBe(true);
      expect(Option.isSome(reDecoded.repos[0]!.sparse)).toBe(true);
    });

    test("decodes config with repos without optional fields", () => {
      const raw = {
        version: 1,
        syncIntervalMinutes: 60,
        repos: [
          {
            url: "https://github.com/test/repo.git",
            alias: "test-repo",
            addedAt: "2026-01-01T00:00:00Z",
          },
        ],
      };
      const decoded = decodeConfig(raw);
      expect(decoded.repos.length).toBe(1);
      expect(Option.isNone(decoded.repos[0]!.pin)).toBe(true);
      expect(Option.isNone(decoded.repos[0]!.lastSyncedAt)).toBe(true);
    });
  });

  describe("makeRepoEntry", () => {
    test("creates a RepoEntry with pin", () => {
      const entry = makeRepoEntry({
        url: "https://github.com/test/repo.git",
        alias: "test",
        pin: Option.some(new RepoPin({ type: "branch", value: "main" })),
        depth: Option.none(),
        sparse: Option.none(),
        addedAt: "2026-01-01",
        lastSyncedAt: Option.some("2026-01-01T12:00:00Z"),
      });
      expect(entry.alias).toBe("test");
      expect(Option.isSome(entry.pin)).toBe(true);
    });

    test("creates a RepoEntry without pin", () => {
      const entry = makeRepoEntry({
        url: "https://github.com/test/repo.git",
        alias: "test",
        pin: Option.none(),
        depth: Option.none(),
        sparse: Option.none(),
        addedAt: "2026-01-01",
        lastSyncedAt: Option.none(),
      });
      expect(Option.isNone(entry.pin)).toBe(true);
      expect(Option.isNone(entry.lastSyncedAt)).toBe(true);
    });
  });

  describe("ConfigService integration", () => {
    test("load returns default when no file exists", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* ConfigService;
          return yield* svc.load();
        }).pipe(Effect.provide(ConfigService.layer), Effect.provide(PlatformLayer)),
      );
      expect(result.version).toBe(1);
      expect(result.repos.length).toBeGreaterThanOrEqual(0);
    });

    test("ensureDirectories creates directories", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* ConfigService;
          yield* svc.ensureDirectories();
        }).pipe(Effect.provide(ConfigService.layer), Effect.provide(PlatformLayer)),
      );
      const home = process.env["SHELF_HOME"]!;
      expect((await stat(join(home, "repos"))).isDirectory()).toBe(true);
    });

    test("repoPath returns correct path", async () => {
      const svc = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* ConfigService;
        }).pipe(Effect.provide(ConfigService.layer), Effect.provide(PlatformLayer)),
      );
      // tests/setup.ts points SHELF_HOME at a temp shelf home
      expect(await Effect.runPromise(svc.repoPath("my-repo"))).toBe(
        join(process.env["SHELF_HOME"]!, "repos", "my-repo"),
      );
    });

    test("repoPath refuses an alias that is not a single safe folder name", async () => {
      const svc = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* ConfigService;
        }).pipe(Effect.provide(ConfigService.layer), Effect.provide(PlatformLayer)),
      );
      for (const alias of ["../outside", "a/b", ".", ""]) {
        const exit = await Effect.runPromiseExit(svc.repoPath(alias));
        expect(exit._tag).toBe("Failure");
      }
    });
  });

  describe("file operations", () => {
    test("save writes valid JSON", async () => {
      await mkdir(tempDir, { recursive: true });
      const encoded = encodeConfig(defaultConfig);
      await writeText(configPath, JSON.stringify(encoded, null, "\t"));
      const content = await readText(configPath);
      const parsed = JSON.parse(content);
      expect(parsed.version).toBe(1);
    });

    test("save creates config with custom interval that can be reloaded", async () => {
      const config = new ShelfConfig({
        version: 1,
        syncIntervalMinutes: 120,
        repos: [],
      });
      const encoded = encodeConfig(config);
      await writeText(configPath, JSON.stringify(encoded, null, "\t"));
      const content = await readText(configPath);
      const reloaded = decodeConfig(JSON.parse(content));
      expect(reloaded.syncIntervalMinutes).toBe(120);
    });
  });
});

describe("ConfigService on a shelf home of its own", () => {
  let home: string;
  let configFile: string;

  /** Builds the real service with SHELF_HOME pointed at `shelfHome`. */
  const serviceAt = async (shelfHome: string) => {
    const previous = process.env["SHELF_HOME"];
    process.env["SHELF_HOME"] = shelfHome;
    try {
      return await Effect.runPromise(
        Effect.gen(function* () {
          return yield* ConfigService;
        }).pipe(Effect.provide(ConfigService.layer), Effect.provide(PlatformLayer)),
      );
    } finally {
      process.env["SHELF_HOME"] = previous;
    }
  };

  const repo = (alias: string, url = `https://github.com/test/${alias}.git`) =>
    makeRepoEntry({
      url,
      alias,
      pin: Option.none(),
      depth: Option.none(),
      sparse: Option.none(),
      addedAt: "2026-01-01T00:00:00Z",
      lastSyncedAt: Option.none(),
    });

  const writeConfig = (config: ShelfConfig) =>
    writeText(configFile, JSON.stringify(encodeConfig(config)));

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "shelf-config-home-"));
    configFile = join(home, "config.json");
  });

  afterEach(async () => {
    await chmod(home, 0o700).catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  });

  describe("paths", () => {
    test("come from SHELF_HOME", async () => {
      const svc = await serviceAt(home);
      expect(svc.shelfHome).toBe(home);
      expect(svc.reposDir).toBe(join(home, "repos"));
      expect(svc.configPath).toBe(configFile);
    });

    test("resolve a relative SHELF_HOME against the working directory", async () => {
      const svc = await serviceAt("relative-shelf");
      expect(svc.shelfHome).toBe(join(process.cwd(), "relative-shelf"));
    });
  });

  describe("load", () => {
    test("gives the stored config", async () => {
      await writeConfig(
        new ShelfConfig({ version: 1, syncIntervalMinutes: 15, repos: [repo("react")] }),
      );
      const config = await Effect.runPromise((await serviceAt(home)).load());
      expect(config.syncIntervalMinutes).toBe(15);
      expect(config.repos.map((r) => r.alias)).toEqual(["react"]);
    });

    test("gives the defaults when no config file exists", async () => {
      const config = await Effect.runPromise((await serviceAt(home)).load());
      expect(config).toEqual(defaultConfig);
    });

    test("fails with an invalid-json ConfigParseError naming the syntax error on malformed JSON", async () => {
      await writeFile(configFile, "{not json");
      const error = await Effect.runPromise(Effect.flip((await serviceAt(home)).load()));
      expect(error._tag).toBe("ConfigParseError");
      expect(error.reason).toBe("invalid-json");
      expect(error.message).toMatch(/^config\.json is not valid JSON: \S/);
      expect(error.message).not.toContain("Failed to read");
    });

    test("fails with an invalid-json ConfigParseError on an empty file", async () => {
      await writeFile(configFile, "");
      const error = await Effect.runPromise(Effect.flip((await serviceAt(home)).load()));
      expect(error.reason).toBe("invalid-json");
      expect(error.message).toMatch(/^config\.json is not valid JSON: \S/);
    });

    test("fails with ConfigParseError when the config can't be read", async () => {
      await mkdir(configFile);
      const error = await Effect.runPromise(Effect.flip((await serviceAt(home)).load()));
      expect(error._tag).toBe("ConfigParseError");
      expect(error.reason).toBeUndefined();
      expect(error.message).toBe("Failed to read config file");
    });

    test.skipIf(runningAsRoot)(
      "fails with ConfigParseError when it can't check for the config",
      async () => {
        const svc = await serviceAt(home);
        await chmod(home, 0o000);
        const error = await Effect.runPromise(Effect.flip(svc.load()));
        expect(error._tag).toBe("ConfigParseError");
        expect(error.message).toBe("Failed to check config file");
      },
    );

    test("fails with ConfigParseError when the JSON does not match the schema", async () => {
      await writeFile(configFile, JSON.stringify({ version: 2, repos: [] }));
      const error = await Effect.runPromise(Effect.flip((await serviceAt(home)).load()));
      expect(error._tag).toBe("ConfigParseError");
      expect(error.message).toBe("Invalid config schema");
    });
  });

  describe("update", () => {
    test("saves and gives the result of applying fn to the stored config", async () => {
      const svc = await serviceAt(home);
      const saved = await Effect.runPromise(
        svc.update(
          (current) =>
            new ShelfConfig({ version: 1, syncIntervalMinutes: 5, repos: current.repos }),
        ),
      );
      expect(saved.syncIntervalMinutes).toBe(5);
      expect(await readJson(configFile)).toEqual({
        version: 1,
        syncIntervalMinutes: 5,
        repos: [],
      });
      expect(await readText(configFile)).toContain('\n\t"syncIntervalMinutes": 5');
      expect((await Effect.runPromise(svc.load())).syncIntervalMinutes).toBe(5);
      expect(await readdir(home)).toEqual(["config.json"]);
    });

    test("accepts an fn that gives an effect", async () => {
      const svc = await serviceAt(home);
      const saved = await Effect.runPromise(
        svc.update(() =>
          Effect.succeed(
            new ShelfConfig({ version: 1, syncIntervalMinutes: 60, repos: [repo("effect")] }),
          ),
        ),
      );
      expect(saved.repos.map((r) => r.alias)).toEqual(["effect"]);
      expect((await Effect.runPromise(svc.load())).repos.map((r) => r.alias)).toEqual(["effect"]);
    });

    test("saves nothing when fn fails, and passes the failure on", async () => {
      await writeConfig(new ShelfConfig({ version: 1, syncIntervalMinutes: 30, repos: [] }));
      const before = await readText(configFile);
      const svc = await serviceAt(home);
      const error = await Effect.runPromise(Effect.flip(svc.update(() => Effect.fail("abort"))));
      expect(error).toBe("abort");
      expect(await readText(configFile)).toBe(before);
      expect(await readdir(home)).toEqual(["config.json"]);
    });

    test("saves nothing when the stored config is invalid", async () => {
      await writeFile(configFile, "{not json");
      const svc = await serviceAt(home);
      let called = false;
      const error = await Effect.runPromise(
        Effect.flip(
          svc.update((current) => {
            called = true;
            return current;
          }),
        ),
      );
      expect(error._tag).toBe("ConfigParseError");
      expect(called).toBe(false);
      expect(await readText(configFile)).toBe("{not json");
    });

    test.skipIf(runningAsRoot)(
      "fails with ConfigWriteError when the config can't be written",
      async () => {
        const svc = await serviceAt(home);
        const error = await Effect.runPromise(
          Effect.flip(
            svc.update((current) =>
              Effect.promise(() => chmod(home, 0o500)).pipe(Effect.as(current)),
            ),
          ),
        );
        expect(error._tag).toBe("ConfigWriteError");
        expect(error.message).toBe("Failed to write config file");
        await chmod(home, 0o700);
        expect(await readdir(home)).not.toContain("config.json");
      },
    );

    test("fails with ConfigWriteError when the config can't be locked", async () => {
      await mkdir(`${configFile}.lock`);
      const svc = await serviceAt(home);
      const error = await Effect.runPromise(Effect.flip(svc.update((current) => current)));
      expect(error._tag).toBe("ConfigWriteError");
      expect(error.message).toContain(`Failed to lock ${configFile}.lock: `);
    });

    test("applies concurrent updates one after another, losing none", async () => {
      const svc = await serviceAt(home);
      const addRepo = (alias: string) =>
        svc.update((current) =>
          Effect.sleep("5 millis").pipe(
            Effect.as(
              new ShelfConfig({
                version: 1,
                syncIntervalMinutes: 60,
                repos: [...current.repos, repo(alias)],
              }),
            ),
          ),
        );
      await Effect.runPromise(
        Effect.all([addRepo("a"), addRepo("b"), addRepo("c"), addRepo("d")], {
          concurrency: "unbounded",
        }),
      );
      const aliases = (await Effect.runPromise(svc.load())).repos.map((r) => r.alias);
      expect([...aliases].sort()).toEqual(["a", "b", "c", "d"]);
    });
  });

  describe("updateRepo", () => {
    const twoRepos = new ShelfConfig({
      version: 1,
      syncIntervalMinutes: 60,
      repos: [repo("react"), repo("vue")],
    });

    test("saves and gives the repo fn returns, leaving the others alone", async () => {
      await writeConfig(twoRepos);
      const svc = await serviceAt(home);
      const result = await Effect.runPromise(
        svc.updateRepo("vue", (r) => repo(r.alias, "https://example.com/vue.git")),
      );
      expect(Option.map(result, (r) => r.url)).toEqual(Option.some("https://example.com/vue.git"));
      const stored = await Effect.runPromise(svc.load());
      expect(stored.repos.map((r) => [r.alias, r.url])).toEqual([
        ["react", "https://github.com/test/react.git"],
        ["vue", "https://example.com/vue.git"],
      ]);
    });

    test("hands fn the whole config and accepts an effect", async () => {
      await writeConfig(twoRepos);
      const svc = await serviceAt(home);
      let seen: ReadonlyArray<string> = [];
      const result = await Effect.runPromise(
        svc.updateRepo("react", (r, current) => {
          seen = current.repos.map((x) => x.alias);
          return Effect.succeed(
            makeRepoEntry({
              url: r.url,
              alias: r.alias,
              pin: r.pin,
              depth: r.depth,
              sparse: r.sparse,
              addedAt: r.addedAt,
              lastSyncedAt: Option.some("now"),
            }),
          );
        }),
      );
      expect(seen).toEqual(["react", "vue"]);
      expect(Option.flatMap(result, (r) => r.lastSyncedAt)).toEqual(Option.some("now"));
    });

    test("gives None and saves nothing when no repo has the alias", async () => {
      await writeConfig(twoRepos);
      const before = await readText(configFile);
      const svc = await serviceAt(home);
      let called = false;
      const result = await Effect.runPromise(
        svc.updateRepo("svelte", (r) => {
          called = true;
          return r;
        }),
      );
      expect(result).toEqual(Option.none());
      expect(called).toBe(false);
      expect(await readText(configFile)).toBe(before);
    });

    test("saves nothing when fn fails, and passes the failure on", async () => {
      await writeConfig(twoRepos);
      const before = await readText(configFile);
      const svc = await serviceAt(home);
      const error = await Effect.runPromise(
        Effect.flip(svc.updateRepo("react", () => Effect.fail("abort"))),
      );
      expect(error).toBe("abort");
      expect(await readText(configFile)).toBe(before);
    });

    test("fails with ConfigParseError when the stored config is invalid", async () => {
      await writeFile(configFile, JSON.stringify({ version: 1 }));
      const svc = await serviceAt(home);
      const error = await Effect.runPromise(Effect.flip(svc.updateRepo("react", (r) => r)));
      expect(error._tag).toBe("ConfigParseError");
    });
  });

  describe("ensureDirectories", () => {
    test("creates the shelf home and its repos folder", async () => {
      const shelfHome = join(home, "nested", "shelf");
      const svc = await serviceAt(shelfHome);
      await Effect.runPromise(svc.ensureDirectories());
      expect((await stat(join(shelfHome, "repos"))).isDirectory()).toBe(true);
      // A second run finds them already there.
      await Effect.runPromise(svc.ensureDirectories());
    });

    test("fails with ConfigWriteError when the folders can't be created", async () => {
      await writeFile(join(home, "file"), "");
      const svc = await serviceAt(join(home, "file", "shelf"));
      const error = await Effect.runPromise(Effect.flip(svc.ensureDirectories()));
      expect(error._tag).toBe("ConfigWriteError");
      expect(error.message).toBe("Failed to create shelf directories");
    });
  });
});
