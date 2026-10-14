// The daemon process's own program (what dist/daemon.mjs runs), run here in
// the test process so its sync loop and shutdown can be observed directly.
// The sync interval runs on a TestClock; the log is what the program prints.

import { describe, expect, test, beforeEach, afterEach, vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { daemonProgram } from "../../../src/domain/daemon/daemon-service";
import { ConfigService } from "../../../src/domain/config/config-service";
import { ConfigParseError } from "../../../src/domain/config/config-errors";
import { ShelfConfig, defaultConfig } from "../../../src/domain/config/config-schema";
import { GitOperationError } from "../../../src/domain/git/git-errors";
import { SyncService, type SyncAllResult } from "../../../src/domain/sync/sync-service";
import { SHELF_VERSION } from "../../../src/version";
import { PlatformLayer } from "../../helpers/platform";
import { readJson } from "../../helpers/files";

type RecordedState = { pid: number; token: string; lastTickAt?: string; version: string };

const configWith = (syncIntervalMinutes: number): ShelfConfig =>
  new ShelfConfig({ version: 1, syncIntervalMinutes, repos: [] });

describe("daemonProgram", () => {
  let home: string;
  let logLines: string[];
  let savedArgv: string[];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "shelf-daemon-program-"));
    logLines = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logLines.push(String(line));
    });
    savedArgv = process.argv;
    process.argv = [...savedArgv, "--token", "test-token"];
  });

  afterEach(async () => {
    process.argv = savedArgv;
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  const statePath = () => join(home, "daemon.json");
  const readState = async (): Promise<RecordedState | undefined> => {
    try {
      return (await readJson(statePath())) as RecordedState;
    } catch {
      return undefined;
    }
  };

  /** Polls (in real time) until `check` holds, failing after 5s. */
  const waitUntil = (check: () => boolean | Promise<boolean>): Effect.Effect<void> =>
    Effect.promise(async () => {
      const deadline = Date.now() + 5000;
      while (!(await check())) {
        if (Date.now() > deadline) throw new Error("timed out waiting for the daemon");
        await sleep(10);
      }
    });

  /** Lets the daemon fiber reach its sleep before the test clock moves. */
  const settle = Effect.promise(() => sleep(30));

  const hasLog = (text: string) => logLines.some((line) => line.includes(text));

  interface Options {
    readonly shelfHome?: string;
    readonly load?: () => Effect.Effect<ShelfConfig, ConfigParseError>;
    readonly syncAll?: () => Effect.Effect<SyncAllResult, ConfigParseError>;
  }

  const layerFor = (options: Options) =>
    Layer.mergeAll(
      Layer.succeed(
        ConfigService,
        ConfigService.of({
          load: options.load ?? (() => Effect.succeed(configWith(30))),
          update: () => Effect.succeed(defaultConfig),
          updateRepo: () => Effect.succeed(Option.none()),
          ensureDirectories: () => Effect.void,
          repoPath: (alias: string) => Effect.succeed(join(home, "repos", alias)),
          shelfHome: options.shelfHome ?? home,
          reposDir: join(home, "repos"),
          configPath: join(home, "config.json"),
        }),
      ),
      Layer.succeed(
        SyncService,
        SyncService.of({
          syncRepo: () => Effect.void,
          syncAll: options.syncAll ?? (() => Effect.succeed({ total: 0, failures: [] })),
        }),
      ),
      PlatformLayer,
      TestClock.layer(),
    );

  /** Runs `body` with the daemon program forked in the background, then interrupts it. */
  const withDaemon = <A>(options: Options, body: () => Effect.Effect<A>): Promise<A> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const daemon = yield* Effect.forkChild(daemonProgram);
        const result = yield* body();
        yield* Fiber.interrupt(daemon);
        return result;
      }).pipe(Effect.provide(layerFor(options))),
    );

  describe("startup", () => {
    test("records itself as running, with no tick yet, before the first sync finishes", async () => {
      const gate = Effect.runSync(Deferred.make<void>());
      await withDaemon(
        {
          syncAll: () =>
            Deferred.await(gate).pipe(Effect.as({ total: 0, failures: [] } as SyncAllResult)),
        },
        () =>
          Effect.gen(function* () {
            yield* waitUntil(async () => (await readState()) !== undefined);
            const state = yield* Effect.promise(readState);
            expect(state).toMatchObject({
              pid: process.pid,
              token: "test-token",
              version: SHELF_VERSION,
            });
            expect(state?.lastTickAt).toBeUndefined();
            expect(hasLog("Daemon started")).toBe(true);
            yield* Deferred.succeed(gate, undefined);
            yield* waitUntil(async () => (await readState())?.lastTickAt !== undefined);
          }),
      );
    });

    test("makes up its own token when started without one", async () => {
      process.argv = savedArgv;
      await withDaemon({}, () =>
        waitUntil(async () => (await readState()) !== undefined).pipe(
          Effect.andThen(Effect.promise(readState)),
          Effect.map((state) => expect(state?.token).toMatch(/^[0-9a-f]{32}$/)),
        ),
      );
    });

    test("keeps running when it cannot record its state", async () => {
      // The shelf home sits under a plain file, so the state file can't be written.
      await writeFile(join(home, "blocker"), "");
      await withDaemon({ shelfHome: join(home, "blocker", "home") }, () =>
        waitUntil(() => hasLog("Sync cycle complete")),
      );
      expect(hasLog("Daemon stopped")).toBe(true);
    });
  });

  describe("sync loop", () => {
    test("a tick that succeeds records its time and waits the configured interval", async () => {
      let ticks = 0;
      await withDaemon(
        {
          syncAll: () =>
            Effect.sync(() => {
              ticks += 1;
              return { total: 0, failures: [] };
            }),
        },
        () =>
          Effect.gen(function* () {
            yield* waitUntil(async () => (await readState())?.lastTickAt !== undefined);
            expect(hasLog("Starting sync cycle (interval: 30m)")).toBe(true);
            expect(hasLog("Sync cycle complete")).toBe(true);
            yield* settle;
            yield* TestClock.adjust("29 minutes");
            yield* settle;
            expect(ticks).toBe(1);
            yield* TestClock.adjust("1 minute");
            yield* waitUntil(() => ticks === 2);
          }),
      );
    });

    test("logs each reference repo that failed to sync and carries on", async () => {
      let ticks = 0;
      await withDaemon(
        {
          syncAll: () =>
            Effect.sync(() => {
              ticks += 1;
              return {
                total: 1,
                failures: [
                  {
                    alias: "react",
                    error: new GitOperationError({ command: "git fetch", message: "boom" }),
                  },
                ],
              };
            }),
        },
        () =>
          Effect.gen(function* () {
            yield* waitUntil(async () => (await readState())?.lastTickAt !== undefined);
            expect(hasLog('Sync failed for "react"')).toBe(true);
            yield* settle;
            yield* TestClock.adjust("30 minutes");
            yield* waitUntil(() => ticks === 2);
          }),
      );
    });

    test("a sync cycle that fails outright is logged and the next tick still runs", async () => {
      let ticks = 0;
      await withDaemon(
        {
          syncAll: () =>
            Effect.suspend(() => {
              ticks += 1;
              return Effect.fail(new ConfigParseError({ message: "Invalid config schema" }));
            }),
        },
        () =>
          Effect.gen(function* () {
            yield* waitUntil(async () => (await readState())?.lastTickAt !== undefined);
            expect(hasLog("Sync cycle failed:")).toBe(true);
            expect(hasLog("Sync cycle complete")).toBe(true);
            yield* settle;
            yield* TestClock.adjust("30 minutes");
            yield* waitUntil(() => ticks === 2);
          }),
      );
    });

    test("a config that fails to load is retried a minute later, without syncing", async () => {
      let loads = 0;
      let ticks = 0;
      await withDaemon(
        {
          load: () =>
            Effect.suspend(() => {
              loads += 1;
              return loads === 1
                ? Effect.fail(new ConfigParseError({ message: "Invalid config schema" }))
                : Effect.succeed(configWith(30));
            }),
          syncAll: () =>
            Effect.sync(() => {
              ticks += 1;
              return { total: 0, failures: [] };
            }),
        },
        () =>
          Effect.gen(function* () {
            yield* waitUntil(() => hasLog("Failed to load config, retrying in 60s"));
            expect(ticks).toBe(0);
            yield* settle;
            yield* TestClock.adjust("1 minute");
            yield* waitUntil(() => ticks === 1);
          }),
      );
    });

    test("an invalid sync interval falls back to the default", async () => {
      await withDaemon({ load: () => Effect.succeed(configWith(0)) }, () =>
        waitUntil(() => hasLog(`interval: ${defaultConfig.syncIntervalMinutes}m`)),
      );
    });
  });

  describe("shutdown", () => {
    test("removes its state file and logs that it stopped", async () => {
      await withDaemon({}, () =>
        waitUntil(async () => (await readState())?.lastTickAt !== undefined),
      );
      expect(existsSync(statePath())).toBe(false);
      expect(hasLog("Received stop signal, shutting down...")).toBe(true);
      expect(hasLog("Daemon stopped")).toBe(true);
    });

    test("keeps a state file another daemon has since recorded", async () => {
      await withDaemon({}, () =>
        Effect.gen(function* () {
          yield* waitUntil(async () => (await readState())?.lastTickAt !== undefined);
          yield* Effect.promise(() =>
            writeFile(
              statePath(),
              JSON.stringify({ pid: 1, token: "other", startedAt: "x", version: "1" }),
            ),
          );
        }),
      );
      expect((await readState())?.token).toBe("other");
      expect(hasLog("Daemon stopped")).toBe(true);
    });

    test("stops cleanly when its state file is already gone", async () => {
      await withDaemon({}, () =>
        Effect.gen(function* () {
          yield* waitUntil(async () => (await readState())?.lastTickAt !== undefined);
          yield* Effect.promise(() => rm(statePath()));
        }),
      );
      expect(existsSync(statePath())).toBe(false);
      expect(hasLog("Daemon stopped")).toBe(true);
    });

    test("leaves an unreadable state file in place", async () => {
      await withDaemon({}, () =>
        Effect.gen(function* () {
          yield* waitUntil(async () => (await readState())?.lastTickAt !== undefined);
          yield* Effect.promise(() => writeFile(statePath(), "{not json"));
        }),
      );
      expect(existsSync(statePath())).toBe(true);
      expect(hasLog("Daemon stopped")).toBe(true);
    });
  });
});
