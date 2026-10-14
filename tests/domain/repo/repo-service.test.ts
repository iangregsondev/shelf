import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { RepoEntry, ShelfConfig, RepoPin } from "../../../src/domain/config/config-schema";
import { RepoService } from "../../../src/domain/repo/repo-service";
import { tempName } from "../../../src/domain/repo/repo-utils";
import { createMockConfigLayer } from "../config/helpers";
import { createMockGitLayer } from "../git/helpers";
import { createMockSyncLayer } from "../sync/helpers";
import { createMockRegistryLayer } from "../registry/helpers";
import { readText, writeText } from "../../helpers/files";
import { PlatformLayer } from "../../helpers/platform";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { GitOperationError } from "../../../src/domain/git/git-errors";
import { ConfigWriteError } from "../../../src/domain/config/config-errors";
import { RegistryWriteError } from "../../../src/domain/registry/registry-errors";

// `add` and `remove` move repo folders to temp names beside them, so give each
// test a fresh shelf home with a real repos folder.
let shelfHome: string;
let reposDir: string;

beforeEach(async () => {
  shelfHome = await mkdtemp(join(tmpdir(), "shelf-repo-service-"));
  reposDir = join(shelfHome, "repos");
  await mkdir(reposDir);
});

afterEach(async () => {
  await rm(shelfHome, { recursive: true, force: true });
});

const buildRepoLayer = (configOverrides = {}, gitOverrides = {}, syncOverrides = {}) => {
  const configLayer = createMockConfigLayer({ shelfHome, ...configOverrides });
  const gitLayer = createMockGitLayer(gitOverrides);
  const syncLayer = createMockSyncLayer(syncOverrides);
  return RepoService.layer.pipe(
    Layer.provide(configLayer),
    Layer.provide(gitLayer),
    Layer.provide(syncLayer),
    Layer.provide(createMockRegistryLayer()),
    Layer.provide(PlatformLayer),
  );
};

describe("RepoService", () => {
  describe("add", () => {
    test("adds a repo and derives alias from URL", async () => {
      let savedConfig: typeof ShelfConfig.Type | undefined;
      const layer = buildRepoLayer({
        save: (config: typeof ShelfConfig.Type) => {
          savedConfig = config;
          return Effect.void;
        },
      });
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* RepoService;
          return yield* repo.add({ url: "https://github.com/Effect-TS/effect.git" });
        }).pipe(Effect.provide(layer)),
      );
      expect(result).toBe("effect");
      expect(savedConfig?.repos.length).toBe(1);
    });

    test("uses provided alias", async () => {
      const layer = buildRepoLayer();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* RepoService;
          return yield* repo.add({
            url: "https://github.com/Effect-TS/effect.git",
            alias: Option.some("my-effect"),
          });
        }).pipe(Effect.provide(layer)),
      );
      expect(result).toBe("my-effect");
    });

    test("rejects duplicate alias", async () => {
      const existingRepo = new RepoEntry({
        url: "https://github.com/test/repo.git",
        alias: "effect",
        addedAt: "2026-01-01",
        pin: Option.none(),
        depth: Option.none(),
        sparse: Option.none(),
        lastSyncedAt: Option.none(),
      });
      const layer = buildRepoLayer({
        load: () =>
          Effect.succeed(
            new ShelfConfig({ version: 1, syncIntervalMinutes: 60, repos: [existingRepo] }),
          ),
      });
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const repo = yield* RepoService;
          return yield* repo.add({ url: "https://github.com/Effect-TS/effect.git" });
        }).pipe(Effect.provide(layer)),
      );
      expect(exit._tag).toBe("Failure");
    });

    test("rejects an alias whose folder is already on disk, and leaves the folder alone", async () => {
      await writeText(join(reposDir, "effect", "keep.txt"), "mine");
      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* RepoService;
          return yield* repo.add({ url: "https://github.com/Effect-TS/effect.git" });
        }).pipe(Effect.flip, Effect.provide(buildRepoLayer())),
      );
      expect(error._tag).toBe("RepoAlreadyExistsError");
      expect(existsSync(join(reposDir, "effect", "keep.txt"))).toBe(true);
    });

    test("fails with RepoFolderError naming the OS error when the folder can't be created", async () => {
      const targetDir = join(reposDir, "missing-parent", "effect");
      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* RepoService;
          return yield* repo.add({ url: "https://github.com/Effect-TS/effect.git" });
        }).pipe(Effect.flip, Effect.provide(buildRepoLayer({ repoPath: () => targetDir }))),
      );
      // The first folder add makes is the temp folder it clones into.
      const cloneDir = (error as { path: string }).path;
      expect(cloneDir).toMatch(/[/\\]missing-parent[/\\]\.shelf-add-effect-\d+-[0-9a-f-]{36}$/);
      expect(error).toMatchObject({
        _tag: "RepoFolderError",
        message: `ENOENT: no such file or directory, mkdir '${cloneDir}'`,
      });
    });

    test("leaves no folder behind when the clone fails", async () => {
      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* RepoService;
          return yield* repo.add({ url: "https://github.com/Effect-TS/effect.git" });
        }).pipe(
          Effect.flip,
          Effect.provide(
            buildRepoLayer(
              {},
              {
                clone: () =>
                  Effect.fail(new GitOperationError({ command: "git clone", message: "boom" })),
              },
            ),
          ),
        ),
      );
      expect(error._tag).toBe("GitOperationError");
      expect(await readdir(reposDir)).toEqual([]);
    });
  });

  describe("rename", () => {
    const configWith = (alias: string) => ({
      load: () =>
        Effect.succeed(
          new ShelfConfig({
            version: 1,
            syncIntervalMinutes: 60,
            repos: [
              new RepoEntry({
                url: "https://github.com/test/repo.git",
                alias,
                addedAt: "2026-01-01",
                pin: Option.none(),
                depth: Option.none(),
                sparse: Option.none(),
                lastSyncedAt: Option.none(),
              }),
            ],
          }),
        ),
    });

    test("moves the folder", async () => {
      await writeText(join(reposDir, "lib", "lib.ts"), "code");
      await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* RepoService;
          yield* repo.rename("lib", "renamed");
        }).pipe(Effect.provide(buildRepoLayer(configWith("lib")))),
      );
      expect(existsSync(join(reposDir, "renamed", "lib.ts"))).toBe(true);
      expect(existsSync(join(reposDir, "lib"))).toBe(false);
    });

    test("fails with AliasRenameError naming the OS error when the folder can't move", async () => {
      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* RepoService;
          yield* repo.rename("lib", "renamed");
        }).pipe(Effect.flip, Effect.provide(buildRepoLayer(configWith("lib")))),
      );
      expect(error).toMatchObject({
        _tag: "AliasRenameError",
        message: `ENOENT: no such file or directory, rename '${join(reposDir, "lib")}' -> '${join(reposDir, "renamed")}'`,
      });
    });

    test("moves the folder back when the config can't follow", async () => {
      await writeText(join(reposDir, "lib", "lib.ts"), "code");
      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* RepoService;
          yield* repo.rename("lib", "renamed");
        }).pipe(
          Effect.flip,
          Effect.provide(
            buildRepoLayer({
              ...configWith("lib"),
              save: () => Effect.fail(new ConfigWriteError({ message: "disk full" })),
            }),
          ),
        ),
      );
      expect(error._tag).toBe("ConfigWriteError");
      expect(existsSync(join(reposDir, "lib", "lib.ts"))).toBe(true);
      expect(existsSync(join(reposDir, "renamed"))).toBe(false);
    });
  });

  describe("add pins", () => {
    test("applies pin on clone", async () => {
      let clonedPin: Option.Option<RepoPin> = Option.none();
      const layer = buildRepoLayer(
        {},
        {
          clone: (_url: string, _dir: string, pin: Option.Option<RepoPin>) => {
            clonedPin = pin;
            return Effect.void;
          },
        },
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* RepoService;
          yield* repo.add({
            url: "https://github.com/test/repo.git",
            alias: Option.some("test"),
            pin: Option.some(new RepoPin({ type: "branch", value: "develop" })),
          });
        }).pipe(Effect.provide(layer)),
      );
      expect(Option.isSome(clonedPin)).toBe(true);
      if (Option.isSome(clonedPin)) {
        expect(clonedPin.value.value).toBe("develop");
      }
    });

    test("forwards depth and sparse to git clone", async () => {
      let clonedDepth: Option.Option<number> = Option.none();
      let clonedSparse: Option.Option<ReadonlyArray<string>> = Option.none();
      const layer = buildRepoLayer(
        {},
        {
          clone: (
            _url: string,
            _dir: string,
            _pin: Option.Option<RepoPin>,
            d: Option.Option<number>,
            s: Option.Option<ReadonlyArray<string>>,
          ) => {
            clonedDepth = d;
            clonedSparse = s;
            return Effect.void;
          },
        },
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* RepoService;
          yield* repo.add({
            url: "https://github.com/test/repo.git",
            alias: Option.some("test"),
            depth: Option.some(1),
            sparse: Option.some(["src", "packages/core"]),
          });
        }).pipe(Effect.provide(layer)),
      );
      expect(Option.isSome(clonedDepth)).toBe(true);
      if (Option.isSome(clonedDepth)) {
        expect(clonedDepth.value).toBe(1);
      }
      expect(Option.isSome(clonedSparse)).toBe(true);
      if (Option.isSome(clonedSparse)) {
        expect(clonedSparse.value).toEqual(["src", "packages/core"]);
      }
    });

    test("handles various URL formats", async () => {
      const layer = buildRepoLayer();
      const gitSshResult = await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* RepoService;
          return yield* repo.add({ url: "git@github.com:user/my-lib.git" });
        }).pipe(Effect.provide(layer)),
      );
      expect(gitSshResult).toBe("my-lib");
    });
  });

  describe("remove", () => {
    test("removes existing repo", async () => {
      const existingRepo = new RepoEntry({
        url: "https://github.com/test/repo.git",
        alias: "test-repo",
        addedAt: "2026-01-01",
        pin: Option.none(),
        depth: Option.none(),
        sparse: Option.none(),
        lastSyncedAt: Option.none(),
      });
      let savedConfig: typeof ShelfConfig.Type | undefined;
      const layer = buildRepoLayer({
        load: () =>
          Effect.succeed(
            new ShelfConfig({ version: 1, syncIntervalMinutes: 60, repos: [existingRepo] }),
          ),
        save: (config: typeof ShelfConfig.Type) => {
          savedConfig = config;
          return Effect.void;
        },
      });
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* RepoService;
          return yield* repo.remove("test-repo");
        }).pipe(Effect.provide(layer)),
      );
      expect(result).toEqual({ alias: "test-repo", orphan: false, trashLeft: [] });
      expect(savedConfig?.repos.length).toBe(0);
    });

    test("fails for unknown alias", async () => {
      const layer = buildRepoLayer();
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const repo = yield* RepoService;
          return yield* repo.remove("nonexistent");
        }).pipe(Effect.provide(layer)),
      );
      expect(exit._tag).toBe("Failure");
    });
  });

  describe("list", () => {
    test("returns empty list", async () => {
      const layer = buildRepoLayer();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* RepoService;
          return yield* repo.list();
        }).pipe(Effect.provide(layer)),
      );
      expect(result).toEqual([]);
    });

    test("returns repos with status info", async () => {
      const existingRepo = new RepoEntry({
        url: "https://github.com/test/repo.git",
        alias: "test-repo",
        addedAt: "2026-01-01",
        pin: Option.some(new RepoPin({ type: "branch", value: "main" })),
        depth: Option.none(),
        sparse: Option.none(),
        lastSyncedAt: Option.some("2026-01-01T12:00:00Z"),
      });
      const layer = buildRepoLayer({
        load: () =>
          Effect.succeed(
            new ShelfConfig({ version: 1, syncIntervalMinutes: 60, repos: [existingRepo] }),
          ),
      });
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* RepoService;
          return yield* repo.list();
        }).pipe(Effect.provide(layer)),
      );
      expect(result.length).toBe(1);
      expect(result[0]!.alias).toBe("test-repo");
    });
  });

  describe("sync", () => {
    test("syncs single repo by alias", async () => {
      let syncedRepo: string | undefined;
      const existingRepo = new RepoEntry({
        url: "https://github.com/test/repo.git",
        alias: "test-repo",
        addedAt: "2026-01-01",
        pin: Option.none(),
        depth: Option.none(),
        sparse: Option.none(),
        lastSyncedAt: Option.none(),
      });
      const layer = buildRepoLayer(
        {
          load: () =>
            Effect.succeed(
              new ShelfConfig({ version: 1, syncIntervalMinutes: 60, repos: [existingRepo] }),
            ),
        },
        {},
        {
          syncRepo: (repo: RepoEntry) => {
            syncedRepo = repo.alias;
            return Effect.void;
          },
        },
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* RepoService;
          yield* repo.sync(Option.some("test-repo"));
        }).pipe(Effect.provide(layer)),
      );
      expect(syncedRepo).toBe("test-repo");
    });

    test("syncs all when no alias", async () => {
      let syncAllCalled = false;
      const layer = buildRepoLayer(
        {},
        {},
        {
          syncAll: () => {
            syncAllCalled = true;
            return Effect.succeed({ total: 0, failures: [] });
          },
        },
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* RepoService;
          yield* repo.sync(Option.none());
        }).pipe(Effect.provide(layer)),
      );
      expect(syncAllCalled).toBe(true);
    });
  });

  describe("resolveAutoPin", () => {
    // resolveAutoPin reads package.json from the working directory, so each
    // test runs inside a temp dir holding its own fixture manifest. The
    // fixture versions are deliberately unlike shelf's own dependencies.
    let fixtureDir: string;
    let originalCwd: string;

    beforeEach(async () => {
      originalCwd = process.cwd();
      fixtureDir = await mkdtemp(join(tmpdir(), "shelf-autopin-"));
      await writeText(
        join(fixtureDir, "package.json"),
        JSON.stringify({
          dependencies: { effect: "^3.10.2" },
          devDependencies: { typescript: "~5.4.0" },
        }),
      );
      process.chdir(fixtureDir);
    });

    afterEach(async () => {
      process.chdir(originalCwd);
      await rm(fixtureDir, { recursive: true, force: true });
    });

    test("resolves matching tag from the project's package.json", async () => {
      const lsRemoteOutput = [
        "abc123\trefs/tags/v3.10.2",
        "def456\trefs/tags/v3.10.2^{}",
        "789abc\trefs/tags/v4.0.4",
      ].join("\n");
      const layer = buildRepoLayer(
        {},
        {
          lsRemoteTags: () => Effect.succeed(lsRemoteOutput),
        },
      );
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* RepoService;
          return yield* repo.resolveAutoPin("https://github.com/Effect-TS/effect.git", "effect");
        }).pipe(Effect.provide(layer)),
      );
      expect(Option.isSome(result)).toBe(true);
      if (Option.isSome(result)) {
        expect(result.value.type).toBe("tag");
        expect(result.value.value).toBe("v3.10.2");
      }
    });

    test("resolves from devDependencies", async () => {
      const layer = buildRepoLayer(
        {},
        {
          lsRemoteTags: () => Effect.succeed("abc123\trefs/tags/v5.4.0"),
        },
      );
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* RepoService;
          return yield* repo.resolveAutoPin(
            "https://github.com/microsoft/typescript.git",
            "typescript",
          );
        }).pipe(Effect.provide(layer)),
      );
      expect(Option.getOrUndefined(result)?.value).toBe("v5.4.0");
    });

    // A package.json that doesn't hold a version string for the package is a
    // typed AutoPinResolutionError, never a crash.
    test.each([
      ["a package.json of null", "null", "effect"],
      ["a version that isn't a string", JSON.stringify({ dependencies: { effect: 5 } }), "effect"],
      [
        "a package named like an Object built-in",
        JSON.stringify({ dependencies: {} }),
        "constructor",
      ],
    ])("fails with AutoPinResolutionError for %s", async (_name, manifest, packageName) => {
      await writeText(join(fixtureDir, "package.json"), manifest);
      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* RepoService;
          return yield* repo.resolveAutoPin("https://github.com/x/y.git", packageName);
        }).pipe(Effect.flip, Effect.provide(buildRepoLayer())),
      );
      expect(error).toMatchObject({
        _tag: "AutoPinResolutionError",
        message: `Package "${packageName}" not found in dependencies or devDependencies`,
      });
    });

    test("fails when package not in dependencies", async () => {
      const layer = buildRepoLayer(
        {},
        {
          lsRemoteTags: () => Effect.succeed(""),
        },
      );
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const repo = yield* RepoService;
          return yield* repo.resolveAutoPin(
            "https://github.com/test/nonexistent-pkg.git",
            "nonexistent-pkg",
          );
        }).pipe(Effect.provide(layer)),
      );
      expect(exit._tag).toBe("Failure");
    });
  });
});

const entry = (alias: string, pin: Option.Option<RepoPin> = Option.none()) =>
  new RepoEntry({
    url: `https://github.com/test/${alias}.git`,
    alias,
    addedAt: "2026-01-01",
    pin,
    depth: Option.none(),
    sparse: Option.none(),
    lastSyncedAt: Option.none(),
  });

/** An id for temp folder names in tests. */
const ID = "0b7c5d3e-1f2a-4b6c-8d9e-0a1b2c3d4e5f";

/** The PID of a process that has already exited. */
const deadPid = (): number => spawnSync(process.execPath, ["-e", ""]).pid;

const configOf = (...repos: ReadonlyArray<RepoEntry>) =>
  new ShelfConfig({ version: 1, syncIntervalMinutes: 60, repos });

/** A `load` that gives each config in turn, then the last one forever. */
const loadSequence = (...configs: ReadonlyArray<ShelfConfig>) => {
  let calls = 0;
  return () => Effect.succeed(configs[Math.min(calls++, configs.length - 1)]!);
};

const runRepo = <A, E>(
  body: (repo: RepoService["Service"]) => Effect.Effect<A, E>,
  layer: Layer.Layer<RepoService, unknown>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* body(yield* RepoService);
    }).pipe(Effect.provide(layer)) as Effect.Effect<A, E>,
  );

const failureOf = <A, E>(
  body: (repo: RepoService["Service"]) => Effect.Effect<A, E>,
  layer: Layer.Layer<RepoService, unknown>,
) => runRepo((repo) => Effect.flip(body(repo)), layer);

describe("RepoService.resolvePin", () => {
  test("an invalid pin fails with PinResolutionError", async () => {
    const error = await failureOf((repo) => repo.resolvePin("u", "commit:xyz"), buildRepoLayer());
    expect(error).toMatchObject({
      _tag: "PinResolutionError",
      message: 'Pin "commit:xyz" is not a commit hash (4 to 40 hex characters)',
    });
  });

  test("an explicit pin is taken as stated, without asking the remote", async () => {
    let asked = false;
    const layer = buildRepoLayer(
      {},
      {
        lsRemoteRefs: () => {
          asked = true;
          return Effect.succeed("");
        },
      },
    );
    const pin = await runRepo((repo) => repo.resolvePin("u", "tag:v1"), layer);
    expect(pin).toEqual(new RepoPin({ type: "tag", value: "v1" }));
    expect(asked).toBe(false);
  });

  test("a bare name is a tag pin when the remote has that tag", async () => {
    const layer = buildRepoLayer(
      {},
      { lsRemoteRefs: () => Effect.succeed("a1\trefs/heads/v1\nb2\trefs/tags/v1") },
    );
    const pin = await runRepo((repo) => repo.resolvePin("u", "v1"), layer);
    expect(pin).toEqual(new RepoPin({ type: "tag", value: "v1" }));
  });

  test("a bare name is a branch pin when the remote has only that branch", async () => {
    const layer = buildRepoLayer({}, { lsRemoteRefs: () => Effect.succeed("a1\trefs/heads/dev") });
    const pin = await runRepo((repo) => repo.resolvePin("u", "dev"), layer);
    expect(pin).toEqual(new RepoPin({ type: "branch", value: "dev" }));
  });

  test("a bare name the remote lacks fails with PinResolutionError", async () => {
    const error = await failureOf(
      (repo) => repo.resolvePin("https://x/y.git", "dev"),
      buildRepoLayer(),
    );
    expect(error).toMatchObject({
      _tag: "PinResolutionError",
      message:
        '"dev" is neither a tag nor a branch on https://x/y.git. Use commit:<hash> for a commit.',
    });
  });
});

describe("RepoService.pin", () => {
  test("fails with RepoNotFoundError for an unknown alias", async () => {
    const error = await failureOf((repo) => repo.pin("nope", "branch:main"), buildRepoLayer());
    expect(error).toMatchObject({ _tag: "RepoNotFoundError", alias: "nope" });
  });

  test("syncs to a branch pin, then saves it", async () => {
    const synced: Array<RepoEntry> = [];
    let saved: ShelfConfig | undefined;
    let ensured = false;
    const layer = buildRepoLayer(
      {
        load: () => Effect.succeed(configOf(entry("lib"))),
        save: (c: ShelfConfig) => {
          saved = c;
          return Effect.void;
        },
      },
      {
        ensureCommit: () => {
          ensured = true;
          return Effect.void;
        },
      },
      {
        syncRepo: (r: RepoEntry) => {
          synced.push(r);
          return Effect.void;
        },
      },
    );
    const pin = await runRepo((repo) => repo.pin("lib", "branch:dev"), layer);
    const expected = new RepoPin({ type: "branch", value: "dev" });
    expect(pin).toEqual(expected);
    expect(synced.map((r) => Option.getOrUndefined(r.pin))).toEqual([expected]);
    expect(Option.getOrUndefined(saved!.repos[0]!.pin)).toEqual(expected);
    expect(ensured).toBe(false);
  });

  test("fetches a commit pin into the clone and stores its full hash", async () => {
    const full = "a".repeat(40);
    const calls: Array<string> = [];
    let saved: ShelfConfig | undefined;
    const layer = buildRepoLayer(
      {
        load: () => Effect.succeed(configOf(entry("lib"))),
        save: (c: ShelfConfig) => {
          saved = c;
          return Effect.void;
        },
      },
      {
        ensureCommit: (dir: string, hash: string) => {
          calls.push(`ensure ${dir} ${hash}`);
          return Effect.void;
        },
        resolveCommit: (dir: string, hash: string) => {
          calls.push(`resolve ${dir} ${hash}`);
          return Effect.succeed(full);
        },
      },
      {
        syncRepo: (r: RepoEntry) => {
          calls.push(`sync ${Option.getOrUndefined(r.pin)?.value}`);
          return Effect.void;
        },
      },
    );
    const pin = await runRepo((repo) => repo.pin("lib", "commit:aaaa"), layer);
    const dir = join(reposDir, "lib");
    expect(calls).toEqual([`ensure ${dir} aaaa`, `resolve ${dir} aaaa`, `sync ${full}`]);
    expect(pin).toEqual(new RepoPin({ type: "commit", value: full }));
    expect(Option.getOrUndefined(saved!.repos[0]!.pin)?.value).toBe(full);
  });

  test("saves nothing when the sync to the pin fails", async () => {
    let saved = false;
    const layer = buildRepoLayer(
      {
        load: () => Effect.succeed(configOf(entry("lib"))),
        save: () => {
          saved = true;
          return Effect.void;
        },
      },
      {},
      {
        syncRepo: () =>
          Effect.fail(new GitOperationError({ command: "git checkout", message: "no" })) as never,
      },
    );
    const error = await failureOf((repo) => repo.pin("lib", "branch:dev"), layer);
    expect(error).toMatchObject({ _tag: "GitOperationError" });
    expect(saved).toBe(false);
  });

  test("fails with RepoNotFoundError when the repo is removed during the sync", async () => {
    const layer = buildRepoLayer({ load: loadSequence(configOf(entry("lib")), configOf()) });
    const error = await failureOf((repo) => repo.pin("lib", "branch:dev"), layer);
    expect(error).toMatchObject({ _tag: "RepoNotFoundError", alias: "lib" });
  });
});

describe("RepoService.add, more", () => {
  test("stores a commit pin as the full hash read from the fresh clone", async () => {
    const full = "b".repeat(40);
    let saved: ShelfConfig | undefined;
    const layer = buildRepoLayer(
      {
        save: (c: ShelfConfig) => {
          saved = c;
          return Effect.void;
        },
      },
      { resolveCommit: () => Effect.succeed(full) },
    );
    await runRepo(
      (repo) =>
        repo.add({
          url: "https://github.com/test/lib.git",
          pin: Option.some(new RepoPin({ type: "commit", value: "bbbb" })),
        }),
      layer,
    );
    expect(saved!.repos[0]!.pin).toEqual(Option.some(new RepoPin({ type: "commit", value: full })));
  });

  test("an add that loses a race for the alias fails and removes the clone it made", async () => {
    const layer = buildRepoLayer({ load: loadSequence(configOf(), configOf(entry("lib"))) });
    const error = await failureOf(
      (repo) => repo.add({ url: "https://github.com/test/lib.git" }),
      layer,
    );
    expect(error).toMatchObject({ _tag: "RepoAlreadyExistsError", alias: "lib" });
    expect(await readdir(reposDir)).toEqual([]);
  });

  test("a remove during the clone leaves the clone alone, and the add completes", async () => {
    const started = Effect.runSync(Deferred.make<void>());
    const gate = Effect.runSync(Deferred.make<void>());
    const layer = buildRepoLayer(
      {},
      {
        clone: (_url: string, dir: string) =>
          Effect.promise(() => writeText(join(dir, "lib.ts"), "code")).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Deferred.await(gate)),
          ),
      },
    );
    const { added, removeError } = await runRepo(
      (repo) =>
        Effect.gen(function* () {
          const adding = yield* Effect.forkChild(
            repo.add({ url: "https://github.com/test/lib.git" }),
          );
          yield* Deferred.await(started);
          const removeError = yield* Effect.flip(repo.remove("lib"));
          yield* Deferred.succeed(gate, undefined);
          return { added: yield* Fiber.join(adding), removeError };
        }),
      layer,
    );
    expect(removeError).toMatchObject({ _tag: "RepoNotFoundError", alias: "lib" });
    expect(added).toBe("lib");
    expect(await readdir(reposDir)).toEqual(["lib"]);
    expect(existsSync(join(reposDir, "lib", "lib.ts"))).toBe(true);
  });

  test("a folder that appears at the alias during the clone is left alone, and the clone removed", async () => {
    const layer = buildRepoLayer(
      {},
      { clone: () => Effect.promise(() => writeText(join(reposDir, "lib", "keep.txt"), "mine")) },
    );
    const error = await failureOf(
      (repo) => repo.add({ url: "https://github.com/test/lib.git" }),
      layer,
    );
    expect(error).toMatchObject({ _tag: "RepoAlreadyExistsError", alias: "lib" });
    expect(await readdir(reposDir)).toEqual(["lib"]);
    expect(await readdir(join(reposDir, "lib"))).toEqual(["keep.txt"]);
  });

  test("fails with RepoFolderError naming the OS error when the clone can't move into place", async () => {
    const layer = buildRepoLayer(
      {},
      { clone: (_url: string, dir: string) => Effect.promise(() => rm(dir, { recursive: true })) },
    );
    const error = await failureOf(
      (repo) => repo.add({ url: "https://github.com/test/lib.git" }),
      layer,
    );
    expect(error).toMatchObject({ _tag: "RepoFolderError", path: join(reposDir, "lib") });
    expect((error as { message: string }).message).toContain("ENOENT");
    expect(await readdir(reposDir)).toEqual([]);
  });

  test("an unsafe alias is refused before anything is cloned", async () => {
    let cloned = false;
    const layer = buildRepoLayer(
      {},
      {
        clone: () => {
          cloned = true;
          return Effect.void;
        },
      },
    );
    const error = await failureOf(
      (repo) => repo.add({ url: "https://x/y.git", alias: Option.some("../escape") }),
      layer,
    );
    expect(error).toMatchObject({ _tag: "InvalidAliasError" });
    expect(cloned).toBe(false);
  });
});

describe("RepoService.remove, more", () => {
  test("removes a repo named by its URL, folder and all", async () => {
    await writeText(join(reposDir, "lib", "lib.ts"), "code");
    let saved: ShelfConfig | undefined;
    const layer = buildRepoLayer({
      load: () => Effect.succeed(configOf(entry("lib"), entry("other"))),
      save: (c: ShelfConfig) => {
        saved = c;
        return Effect.void;
      },
    });
    const removed = await runRepo((repo) => repo.remove("https://github.com/test/lib.git"), layer);
    expect(removed).toEqual({ alias: "lib", orphan: false, trashLeft: [] });
    expect(existsSync(join(reposDir, "lib"))).toBe(false);
    expect(saved!.repos.map((r) => r.alias)).toEqual(["other"]);
  });
});

describe("RepoService.rename, more", () => {
  test("an unsafe new alias is refused", async () => {
    const error = await failureOf(
      (repo) => repo.rename("lib", "../x"),
      buildRepoLayer({ load: () => Effect.succeed(configOf(entry("lib"))) }),
    );
    expect(error).toMatchObject({ _tag: "InvalidAliasError" });
  });

  test("fails with RepoNotFoundError for an unknown alias", async () => {
    const error = await failureOf((repo) => repo.rename("lib", "renamed"), buildRepoLayer());
    expect(error).toMatchObject({ _tag: "RepoNotFoundError", alias: "lib" });
  });

  test("fails with RepoAlreadyExistsError when the new alias is taken", async () => {
    const error = await failureOf(
      (repo) => repo.rename("lib", "other"),
      buildRepoLayer({ load: () => Effect.succeed(configOf(entry("lib"), entry("other"))) }),
    );
    expect(error).toMatchObject({ _tag: "RepoAlreadyExistsError", alias: "other" });
  });

  test("refuses when a folder is already at the new path, and moves nothing", async () => {
    await writeText(join(reposDir, "lib", "lib.ts"), "code");
    await writeText(join(reposDir, "renamed", "stray.txt"), "x");
    const error = await failureOf(
      (repo) => repo.rename("lib", "renamed"),
      buildRepoLayer({ load: () => Effect.succeed(configOf(entry("lib"))) }),
    );
    expect(error).toMatchObject({
      _tag: "AliasRenameError",
      message: `a folder already exists at ${join(reposDir, "renamed")}`,
    });
    expect(existsSync(join(reposDir, "lib", "lib.ts"))).toBe(true);
    expect(existsSync(join(reposDir, "renamed", "lib.ts"))).toBe(false);
  });

  test("renames the config entry and the manual registry entry", async () => {
    await writeText(join(reposDir, "lib", "lib.ts"), "code");
    let saved: ShelfConfig | undefined;
    const renamed: Array<[string, string]> = [];
    const layer = RepoService.layer.pipe(
      Layer.provide(
        createMockConfigLayer({
          repoPath: (alias: string) => join(reposDir, alias),
          load: () => Effect.succeed(configOf(entry("lib"))),
          save: (c: ShelfConfig) => {
            saved = c;
            return Effect.void;
          },
        }),
      ),
      Layer.provide(createMockGitLayer()),
      Layer.provide(createMockSyncLayer()),
      Layer.provide(
        createMockRegistryLayer({
          renameManual: (from: string, to: string) => {
            renamed.push([from, to]);
            return Effect.void;
          },
        } as never),
      ),
      Layer.provide(PlatformLayer),
    );
    await runRepo((repo) => repo.rename("lib", "renamed"), layer);
    expect(saved!.repos.map((r) => r.alias)).toEqual(["renamed"]);
    expect(renamed).toEqual([["lib", "renamed"]]);
  });

  test("moves the folder back when another rename takes the alias first", async () => {
    await writeText(join(reposDir, "lib", "lib.ts"), "code");
    const layer = buildRepoLayer({
      load: loadSequence(configOf(entry("lib")), configOf(entry("lib"), entry("renamed"))),
    });
    const error = await failureOf((repo) => repo.rename("lib", "renamed"), layer);
    expect(error).toMatchObject({ _tag: "RepoAlreadyExistsError", alias: "renamed" });
    expect(existsSync(join(reposDir, "lib", "lib.ts"))).toBe(true);
    expect(existsSync(join(reposDir, "renamed"))).toBe(false);
  });

  test("moves the folder back when the repo is removed mid-rename", async () => {
    await writeText(join(reposDir, "lib", "lib.ts"), "code");
    const layer = buildRepoLayer({ load: loadSequence(configOf(entry("lib")), configOf()) });
    const error = await failureOf((repo) => repo.rename("lib", "renamed"), layer);
    expect(error).toMatchObject({ _tag: "RepoNotFoundError", alias: "lib" });
    expect(existsSync(join(reposDir, "lib", "lib.ts"))).toBe(true);
    expect(existsSync(join(reposDir, "renamed"))).toBe(false);
  });
});

describe("RepoService.folder", () => {
  test("describes a repo folder that is on disk", async () => {
    await writeText(join(reposDir, "lib", "a.txt"), "12345");
    await writeText(join(reposDir, "lib", "src", "b.ts"), "123");
    const folder = await runRepo((repo) => repo.folder("lib"), buildRepoLayer());
    expect({ ...folder, contents: [...folder.contents].sort() }).toEqual({
      path: join(reposDir, "lib"),
      exists: true,
      sizeBytes: 8,
      contents: ["a.txt", "src"],
    });
  });

  test("describes a missing repo folder as empty", async () => {
    const folder = await runRepo((repo) => repo.folder("lib"), buildRepoLayer());
    expect(folder).toEqual({
      path: join(reposDir, "lib"),
      exists: false,
      sizeBytes: 0,
      contents: [],
    });
  });
});

describe("RepoService.resolveAutoPin, failures", () => {
  let fixtureDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    fixtureDir = await mkdtemp(join(tmpdir(), "shelf-autopin-fail-"));
    process.chdir(fixtureDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(fixtureDir, { recursive: true, force: true });
  });

  const autoPin = (packageName: string, tags = "") =>
    failureOf(
      (repo) => repo.resolveAutoPin("https://x/y.git", packageName),
      buildRepoLayer({}, { lsRemoteTags: () => Effect.succeed(tags) }),
    );

  test("fails when the working directory has no package.json", async () => {
    expect(await autoPin("effect")).toMatchObject({
      _tag: "AutoPinResolutionError",
      message: "No package.json found in current directory",
    });
  });

  test("fails the same way when package.json is not JSON", async () => {
    await writeText(join(fixtureDir, "package.json"), "{ not json");
    expect(await autoPin("effect")).toMatchObject({
      _tag: "AutoPinResolutionError",
      message: "No package.json found in current directory",
    });
  });

  test("looks past a null dependencies field to devDependencies", async () => {
    await writeText(
      join(fixtureDir, "package.json"),
      JSON.stringify({ dependencies: null, devDependencies: { effect: "^1.2.3" } }),
    );
    const pin = await runRepo(
      (repo) => repo.resolveAutoPin("https://x/y.git", "effect"),
      buildRepoLayer({}, { lsRemoteTags: () => Effect.succeed("a\trefs/tags/v1.2.3") }),
    );
    expect(pin).toEqual(Option.some(new RepoPin({ type: "tag", value: "v1.2.3" })));
  });

  test("fails when the remote has no tag for the declared version", async () => {
    await writeText(
      join(fixtureDir, "package.json"),
      JSON.stringify({ dependencies: { effect: "^1.2.3" } }),
    );
    expect(await autoPin("effect", "a\trefs/tags/v9.9.9")).toMatchObject({
      _tag: "AutoPinResolutionError",
      message: "No matching tag found for effect@1.2.3",
    });
  });
});

describe("RepoService.sync, more", () => {
  test("fails with RepoNotFoundError for an unknown alias", async () => {
    const error = await failureOf((repo) => repo.sync(Option.some("nope")), buildRepoLayer());
    expect(error).toMatchObject({ _tag: "RepoNotFoundError", alias: "nope" });
  });

  test("reports one repo and no failures after syncing an alias", async () => {
    const result = await runRepo(
      (repo) => repo.sync(Option.some("lib")),
      buildRepoLayer({ load: () => Effect.succeed(configOf(entry("lib"))) }),
    );
    expect(result).toEqual({ total: 1, failures: [] });
  });

  test("passes back the result of syncing every repo", async () => {
    const all = { total: 3, failures: [{ alias: "x", error: "boom" }] };
    const result = await runRepo(
      (repo) => repo.sync(Option.none()),
      buildRepoLayer({}, {}, { syncAll: () => Effect.succeed(all as never) }),
    );
    expect(result).toEqual(all);
  });

  // Every pin kind reaches the sync unchanged: the sync domain decides what
  // each pin means.
  test.each([
    ["a branch pin", Option.some(new RepoPin({ type: "branch", value: "dev" }))],
    ["a tag pin", Option.some(new RepoPin({ type: "tag", value: "v1.0.0" }))],
    ["a commit pin", Option.some(new RepoPin({ type: "commit", value: "c".repeat(40) }))],
    ["no pin", Option.none<RepoPin>()],
  ])("syncs a repo with %s as stored", async (_name, pin) => {
    const synced: Array<Option.Option<RepoPin>> = [];
    const layer = buildRepoLayer(
      { load: () => Effect.succeed(configOf(entry("lib", pin))) },
      {},
      {
        syncRepo: (r: RepoEntry) => {
          synced.push(r.pin);
          return Effect.void;
        },
      },
    );
    await runRepo((repo) => repo.sync(Option.some("lib")), layer);
    expect(synced).toEqual([pin]);
  });
});

describe("RepoService.remove, orphans and failures", () => {
  test("an alias with no config entry but a folder on disk removes the orphan folder", async () => {
    await writeText(join(reposDir, "ghost", "a.txt"), "x");
    let saved = false;
    const layer = buildRepoLayer({
      load: () => Effect.succeed(configOf(entry("other"))),
      save: () => {
        saved = true;
        return Effect.void;
      },
    });
    const removed = await runRepo((repo) => repo.remove("ghost"), layer);
    expect(removed).toEqual({ alias: "ghost", orphan: true, trashLeft: [] });
    expect(existsSync(join(reposDir, "ghost"))).toBe(false);
    expect(saved).toBe(false);
  });

  test("a repo with a config entry is reported as not an orphan", async () => {
    await writeText(join(reposDir, "lib", "lib.ts"), "code");
    const removed = await runRepo(
      (repo) => repo.remove("lib"),
      buildRepoLayer({ load: () => Effect.succeed(configOf(entry("lib"))) }),
    );
    expect(removed).toEqual({ alias: "lib", orphan: false, trashLeft: [] });
  });

  test("a URL with no config entry fails with RepoNotFoundError", async () => {
    const error = await failureOf(
      (repo) => repo.remove("https://github.com/test/nope.git"),
      buildRepoLayer(),
    );
    expect(error).toMatchObject({
      _tag: "RepoNotFoundError",
      alias: "https://github.com/test/nope.git",
    });
  });

  test("a folder that can't be moved aside fails with RepoRemoveError, and keeps the folder and the config entry", async () => {
    await writeText(join(reposDir, "lib", "a.ts"), "a");
    await writeText(join(reposDir, "lib", "b.ts"), "b");
    let saved = false;
    const layer = buildRepoLayer({
      load: () => Effect.succeed(configOf(entry("lib"))),
      save: () => {
        saved = true;
        return Effect.void;
      },
    });
    // A read-only repos folder: nothing inside it can be renamed or deleted.
    await chmod(reposDir, 0o555);
    try {
      const error = await failureOf((repo) => repo.remove("lib"), layer);
      expect(error).toMatchObject({ _tag: "RepoRemoveError", path: join(reposDir, "lib") });
      expect((error as { message: string }).message).toContain("EACCES");
    } finally {
      await chmod(reposDir, 0o755);
    }
    expect(saved).toBe(false);
    expect(await readdir(reposDir)).toEqual(["lib"]);
    expect((await readdir(join(reposDir, "lib"))).sort()).toEqual(["a.ts", "b.ts"]);
  });

  test("a failed delete after the move aside still drops the entry, and leaves only trash", async () => {
    await writeText(join(reposDir, "lib", "lib.ts"), "code");
    let saved: ShelfConfig | undefined;
    const layer = buildRepoLayer({
      load: () => Effect.succeed(configOf(entry("lib"), entry("keep"))),
      save: (c: ShelfConfig) => {
        saved = c;
        return Effect.void;
      },
    });
    // A read-only repo folder can be renamed, but nothing inside it deleted.
    await chmod(join(reposDir, "lib"), 0o555);
    let left: ReadonlyArray<string> = [];
    try {
      const removed = await runRepo((repo) => repo.remove("lib"), layer);
      left = await readdir(reposDir);
      expect(left).toEqual([expect.stringMatching(/^\.shelf-trash-lib-\d+-[0-9a-f-]{36}$/)]);
      expect(removed).toEqual({
        alias: "lib",
        orphan: false,
        trashLeft: [{ path: join(reposDir, left[0]!), message: expect.stringContaining("EACCES") }],
      });
    } finally {
      await Promise.all(left.map((name) => chmod(join(reposDir, name), 0o755)));
    }
    expect(saved?.repos.map((r) => r.alias)).toEqual(["keep"]);
  });

  test("moves the folder back when the config write fails", async () => {
    await writeText(join(reposDir, "lib", "lib.ts"), "code");
    const layer = buildRepoLayer({
      load: () => Effect.succeed(configOf(entry("lib"))),
      save: () => Effect.fail(new ConfigWriteError({ message: "disk full" })),
    });
    const error = await failureOf((repo) => repo.remove("lib"), layer);
    expect(error).toMatchObject({ _tag: "ConfigWriteError" });
    expect(await readdir(reposDir)).toEqual(["lib"]);
    expect(existsSync(join(reposDir, "lib", "lib.ts"))).toBe(true);
  });

  test("trash cleared while the config write fails can't take the folder it moves back", async () => {
    await writeText(join(reposDir, "lib", "lib.ts"), "code");
    // Another remove or prune clears trash just as this remove's write fails.
    let service: RepoService["Service"] | undefined;
    const layer = buildRepoLayer({
      load: () => Effect.succeed(configOf(entry("lib"))),
      save: () =>
        service!
          .clearTrash()
          .pipe(Effect.andThen(Effect.fail(new ConfigWriteError({ message: "disk full" })))),
    });
    const error = await failureOf((repo) => {
      service = repo;
      return repo.remove("lib");
    }, layer);
    expect(error).toMatchObject({ _tag: "ConfigWriteError" });
    expect(await readdir(reposDir)).toEqual(["lib"]);
    expect(existsSync(join(reposDir, "lib", "lib.ts"))).toBe(true);
  });

  test("a failed config write after the add moves its clone into place leaves no folder", async () => {
    const layer = buildRepoLayer({
      save: () => Effect.fail(new ConfigWriteError({ message: "disk full" })),
    });
    const error = await failureOf(
      (repo) => repo.add({ url: "https://github.com/test/lib.git" }),
      layer,
    );
    expect(error).toMatchObject({ _tag: "ConfigWriteError" });
    expect(await readdir(reposDir)).toEqual([]);
  });

  test("clears trash left by an earlier remove", async () => {
    await writeText(join(reposDir, "lib", "lib.ts"), "code");
    await writeText(join(reposDir, ".shelf-trash-old-1234", "old.ts"), "old");
    const running = tempName("add", "new", process.pid, ID);
    await writeText(join(reposDir, running, "new.ts"), "new");
    const removed = await runRepo(
      (repo) => repo.remove("lib"),
      buildRepoLayer({ load: () => Effect.succeed(configOf(entry("lib"))) }),
    );
    expect(removed).toEqual({ alias: "lib", orphan: false, trashLeft: [] });
    // Only trash goes: this add's process is alive, so its clone may still be running.
    expect(await readdir(reposDir)).toEqual([running]);
  });
});

describe("RepoService.clearTrash", () => {
  test("deletes every trash folder, and nothing else", async () => {
    await writeText(join(reposDir, ".shelf-trash-a-1", "a.ts"), "a");
    await writeText(join(reposDir, ".shelf-trash-b-2", "b.ts"), "b");
    await writeText(join(reposDir, "lib", "lib.ts"), "code");
    const left = await runRepo((repo) => repo.clearTrash(), buildRepoLayer());
    expect(left).toEqual([]);
    expect(await readdir(reposDir)).toEqual(["lib"]);
  });

  test("deletes the folder of an add whose process is gone, and keeps a live one's", async () => {
    const dead = tempName("add", "lib", deadPid(), ID);
    const live = tempName("add", "other", process.pid, ID);
    await writeText(join(reposDir, dead, "lib.ts"), "code");
    await writeText(join(reposDir, live, "other.ts"), "code");
    const left = await runRepo((repo) => repo.clearTrash(), buildRepoLayer());
    expect(left).toEqual([]);
    expect(await readdir(reposDir)).toEqual([live]);
  });

  test("moves a dead remove's folder back when its entry is still saved and its folder missing", async () => {
    await writeText(join(reposDir, tempName("removing", "lib", deadPid(), ID), "lib.ts"), "code");
    let saved = false;
    const layer = buildRepoLayer({
      load: () => Effect.succeed(configOf(entry("lib"))),
      save: () => {
        saved = true;
        return Effect.void;
      },
    });
    expect(await runRepo((repo) => repo.clearTrash(), layer)).toEqual([]);
    expect(await readdir(reposDir)).toEqual(["lib"]);
    expect(await readText(join(reposDir, "lib", "lib.ts"))).toBe("code");
    expect(saved).toBe(false);
  });

  test("deletes a dead remove's folder when its entry is gone", async () => {
    await writeText(join(reposDir, tempName("removing", "lib", deadPid(), ID), "lib.ts"), "code");
    const layer = buildRepoLayer({ load: () => Effect.succeed(configOf(entry("other"))) });
    expect(await runRepo((repo) => repo.clearTrash(), layer)).toEqual([]);
    expect(await readdir(reposDir)).toEqual([]);
  });

  test("deletes a dead remove's folder when the repo folder is already back in place", async () => {
    await writeText(join(reposDir, tempName("removing", "lib", deadPid(), ID), "old.ts"), "old");
    await writeText(join(reposDir, "lib", "lib.ts"), "new");
    const layer = buildRepoLayer({ load: () => Effect.succeed(configOf(entry("lib"))) });
    expect(await runRepo((repo) => repo.clearTrash(), layer)).toEqual([]);
    expect(await readdir(reposDir)).toEqual(["lib"]);
    expect(await readdir(join(reposDir, "lib"))).toEqual(["lib.ts"]);
  });

  test("never moves a dead remove's folder to an unsafe alias read from its name", async () => {
    await writeText(join(reposDir, tempName("removing", "..", deadPid(), ID), "x.ts"), "x");
    const layer = buildRepoLayer({ load: () => Effect.succeed(configOf(entry(".."))) });
    expect(await runRepo((repo) => repo.clearTrash(), layer)).toEqual([]);
    expect(await readdir(reposDir)).toEqual([]);
    expect(await readdir(shelfHome)).toEqual(["repos"]);
  });

  test("keeps the folder of a remove whose process is alive", async () => {
    const live = tempName("removing", "lib", process.pid, ID);
    await writeText(join(reposDir, live, "lib.ts"), "code");
    const layer = buildRepoLayer({ load: () => Effect.succeed(configOf(entry("lib"))) });
    expect(await runRepo((repo) => repo.clearTrash(), layer)).toEqual([]);
    expect(await readdir(reposDir)).toEqual([live]);
  });

  test("finds nothing to clear when the repos folder is missing", async () => {
    await rm(reposDir, { recursive: true });
    expect(await runRepo((repo) => repo.clearTrash(), buildRepoLayer())).toEqual([]);
  });
});

describe("RepoService.rename, case changes and rollback", () => {
  /** A config mock that keeps what it saves, so a rollback can be seen. */
  const statefulConfig = (initial: ShelfConfig) => {
    const state = { current: initial };
    return {
      state,
      overrides: {
        load: () => Effect.succeed(state.current),
        save: (c: ShelfConfig) => {
          state.current = c;
          return Effect.void;
        },
      },
    };
  };

  const layerWith = (
    configOverrides: object,
    renameManual: (from: string, to: string) => Effect.Effect<void, unknown>,
  ) =>
    RepoService.layer.pipe(
      Layer.provide(
        createMockConfigLayer({
          repoPath: (alias: string) => join(reposDir, alias),
          ...configOverrides,
        }),
      ),
      Layer.provide(createMockGitLayer()),
      Layer.provide(createMockSyncLayer()),
      Layer.provide(createMockRegistryLayer({ renameManual } as never)),
      Layer.provide(PlatformLayer),
    );

  test("a case-only rename renames the folder and the config entry", async () => {
    await writeText(join(reposDir, "lib", "lib.ts"), "code");
    const { state, overrides } = statefulConfig(configOf(entry("lib")));
    await runRepo(
      (repo) => repo.rename("lib", "Lib"),
      layerWith(overrides, () => Effect.void),
    );
    expect(await readdir(reposDir)).toEqual(["Lib"]);
    expect(existsSync(join(reposDir, "Lib", "lib.ts"))).toBe(true);
    expect(state.current.repos.map((r) => r.alias)).toEqual(["Lib"]);
  });

  test("a case-only rename moves the folder back when the config can't follow", async () => {
    await writeText(join(reposDir, "lib", "lib.ts"), "code");
    const error = await failureOf(
      (repo) => repo.rename("lib", "Lib"),
      layerWith(
        {
          load: () => Effect.succeed(configOf(entry("lib"))),
          save: () => Effect.fail(new ConfigWriteError({ message: "disk full" })),
        },
        () => Effect.void,
      ),
    );
    expect(error._tag).toBe("ConfigWriteError");
    expect(await readdir(reposDir)).toEqual(["lib"]);
  });

  test("rolls back the folder and the config entry when the registry rename fails", async () => {
    await writeText(join(reposDir, "lib", "lib.ts"), "code");
    const { state, overrides } = statefulConfig(configOf(entry("lib")));
    const error = await failureOf(
      (repo) => repo.rename("lib", "renamed"),
      layerWith(overrides, () => Effect.fail(new RegistryWriteError({ message: "locked" }))),
    );
    expect(error).toMatchObject({ _tag: "RegistryWriteError" });
    expect(state.current.repos.map((r) => r.alias)).toEqual(["lib"]);
    expect(existsSync(join(reposDir, "lib", "lib.ts"))).toBe(true);
    expect(existsSync(join(reposDir, "renamed"))).toBe(false);
  });
});

describe("RepoService.size", () => {
  test("is the total bytes of the repo folder", async () => {
    await writeText(join(reposDir, "lib", "a.txt"), "12345");
    await writeText(join(reposDir, "lib", "src", "b.ts"), "123");
    expect(await runRepo((repo) => repo.size("lib"), buildRepoLayer())).toBe(8);
  });

  test("is 0 for a missing repo folder", async () => {
    expect(await runRepo((repo) => repo.size("lib"), buildRepoLayer())).toBe(0);
  });
});
