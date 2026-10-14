import { describe, expect, test, beforeEach, afterEach } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import type * as ChildProcess from "effect/process/ChildProcess";
import {
  ChildProcessSpawner,
  ExitCode,
  makeHandle,
  make as makeSpawner,
  type ChildProcessHandle,
} from "effect/process/ChildProcessSpawner";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonEntry, DaemonService } from "../../../src/domain/daemon/daemon-service";
import { DaemonState, encodeDaemonState } from "../../../src/domain/daemon/daemon-schema";
import { createMockConfigLayer } from "../config/helpers";
import { isAlive, stopDaemonIn } from "../../helpers/daemon";
import { waitUntil } from "../../helpers/wait";
import { PlatformLayer } from "../../helpers/platform";
import { SHELF_VERSION } from "../../../src/version";
import { readJson } from "../../helpers/files";

/** The daemon entry point the test run built into the repo's `dist` (see tests/global-setup.ts). */
const BUILT_DAEMON_ENTRY = join(import.meta.dirname, "../../../dist/daemon.mjs");

const failure = (method: string) =>
  PlatformError.systemError({ _tag: "Unknown", module: "ChildProcess", method });

const isPs = (command: ChildProcess.Command): boolean =>
  command._tag === "StandardCommand" && command.command === "ps";

/** `handle` with some of its operations replaced. */
const withHandle = (
  handle: ChildProcessHandle,
  overrides: Partial<ChildProcessHandle>,
): ChildProcessHandle => makeHandle({ ...handle, ...overrides });

/** How a fake daemon process answers SIGTERM. */
type FakeDaemonKind = "exits" | "ignores" | "hands-over";

const FAKE_DAEMON_SCRIPTS: Record<FakeDaemonKind, string> = {
  exits: "setInterval(()=>{},1000)",
  ignores: "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
  // Another daemon takes over the state file as this one exits.
  "hands-over": [
    "const p=require('path').join(require('path').dirname(process.argv[1]),'daemon.json');",
    "process.on('SIGTERM',()=>{",
    "require('fs').writeFileSync(p,JSON.stringify({pid:1,token:'other',startedAt:'x',version:'1'}));",
    "process.exit(0)});setInterval(()=>{},1000)",
  ].join(""),
};

type Spawn = ChildProcessSpawner["Service"]["spawn"];

interface LayerOptions {
  /** The daemon entry point to launch; the built dist/daemon.mjs by default. */
  readonly entry?: string;
  /** Wraps the real process spawner, to make spawning or a process handle fail. */
  readonly spawner?: (real: Spawn) => Spawn;
}

describe("DaemonService", () => {
  let tempDir: string;
  let startedPids: number[] = [];

  const configLayer = () => createMockConfigLayer({ shelfHome: tempDir });

  const createTestLayer = (options: LayerOptions = {}) => {
    const { spawner } = options;
    const spawnerLayer =
      spawner === undefined
        ? PlatformLayer
        : Layer.effect(
            ChildProcessSpawner,
            Effect.gen(function* () {
              const real = yield* ChildProcessSpawner;
              return makeSpawner(spawner((command) => real.spawn(command)));
            }),
          ).pipe(Layer.provide(PlatformLayer));
    return DaemonService.layer.pipe(
      Layer.provide(configLayer()),
      Layer.provide(Layer.succeed(DaemonEntry, options.entry ?? BUILT_DAEMON_ENTRY)),
      Layer.provide(spawnerLayer),
      Layer.provide(PlatformLayer),
    );
  };

  const run = <A, E>(
    f: (daemon: DaemonService["Service"]) => Effect.Effect<A, E>,
    options?: LayerOptions,
  ) =>
    Effect.runPromiseExit(
      Effect.gen(function* () {
        return yield* f(yield* DaemonService);
      }).pipe(Effect.provide(createTestLayer(options))),
    );

  const runOk = async <A, E>(
    f: (daemon: DaemonService["Service"]) => Effect.Effect<A, E>,
    options?: LayerOptions,
  ): Promise<A> => {
    const exit = await run(f, options);
    if (Exit.isFailure(exit)) throw new Error(String(exit.cause));
    return exit.value;
  };

  /** The error a failed run failed with. */
  const errorOf = async <A, E>(
    f: (daemon: DaemonService["Service"]) => Effect.Effect<A, E>,
    options?: LayerOptions,
  ): Promise<E> => {
    const exit = await run(f, options);
    if (Exit.isSuccess(exit)) throw new Error("expected the run to fail");
    const reason = exit.cause.reasons.find((r) => r._tag === "Fail");
    if (reason === undefined || reason._tag !== "Fail") throw new Error(String(exit.cause));
    return reason.error;
  };

  const messageOf = (error: unknown): string => (error as { message: string }).message;

  const statePath = () => join(tempDir, "daemon.json");
  const logPath = () => join(tempDir, "daemon.log");

  const writeState = async (
    pid: number,
    token: string,
    startedAt = new Date().toISOString(),
  ): Promise<void> => {
    const state = new DaemonState({
      pid,
      token,
      startedAt,
      lastTickAt: Option.none(),
      version: "0.1.1",
    });
    await writeFile(statePath(), JSON.stringify(encodeDaemonState(state), null, "\t"));
  };

  const writeStaleState = () => writeState(999_999_999, "deadbeef".repeat(4));

  /**
   * Starts a process that looks like a shelf daemon (it runs a `daemon.mjs`
   * with `--token`) and records it in the state file, as a real one would.
   */
  const startFakeDaemon = async (
    kind: FakeDaemonKind,
    startedAt?: string,
  ): Promise<{ pid: number; token: string }> => {
    const token = `fake-${kind}`;
    const script = `${FAKE_DAEMON_SCRIPTS[kind]};console.log('ready')`;
    const child = spawn(
      process.execPath,
      ["-e", script, join(tempDir, "daemon.mjs"), "--token", token],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    // Wait until its SIGTERM handler is installed.
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve());
      child.once("error", reject);
    });
    child.stdout.destroy();
    const pid = child.pid!;
    startedPids.push(pid);
    await writeState(pid, token, startedAt);
    return { pid, token };
  };

  /** Writes a daemon entry point script into the test's temp dir and returns its path. */
  const writeEntry = async (name: string, code: string): Promise<string> => {
    const dir = join(tempDir, "entries");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${name}.mjs`);
    await writeFile(path, code);
    return path;
  };

  /** An entry point that never reports running: it records its pid, and "stopped" on SIGTERM. */
  const writeLingeringEntry = () =>
    writeEntry(
      "lingering",
      [
        "import { writeFileSync } from 'node:fs';",
        "const dir = import.meta.dirname;",
        "writeFileSync(dir + '/pid', String(process.pid));",
        "process.on('SIGTERM', () => { writeFileSync(dir + '/stopped', ''); process.exit(0); });",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );

  /** The pid the lingering entry point recorded, tracked for cleanup. */
  const lingeringPid = async (): Promise<number> => {
    const path = join(tempDir, "entries", "pid");
    await waitUntil(() => existsSync(path));
    const pid = Number(await readFile(path, "utf8"));
    startedPids.push(pid);
    return pid;
  };

  /** Starts a real daemon in this test's shelf home and records its PID for cleanup. */
  const startRealDaemon = async (): Promise<number> => {
    // The daemon child inherits SHELF_HOME, so point it at this test's shelf home.
    const previousHome = process.env["SHELF_HOME"];
    process.env["SHELF_HOME"] = tempDir;
    try {
      const pid = await runOk((daemon) => daemon.start());
      startedPids.push(pid);
      return pid;
    } finally {
      process.env["SHELF_HOME"] = previousHome;
    }
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "shelf-daemon-test-"));
  });

  afterEach(async () => {
    delete process.env["SHELF_DAEMON_STOP_TIMEOUT_MS"];
    await chmod(tempDir, 0o755);
    // Runs even when a test fails: never leave a daemon behind.
    await stopDaemonIn(tempDir, startedPids);
    startedPids = [];
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("status", () => {
    test("returns not running when no state file exists", async () => {
      expect(await runOk((daemon) => daemon.status())).toEqual({ running: false });
    });

    test("returns not running when the state file can't be read", async () => {
      await writeFile(statePath(), "{not json");
      expect(await runOk((daemon) => daemon.status())).toEqual({ running: false });
    });

    test("returns not running when PID is dead (stale state)", async () => {
      await writeStaleState();
      const result = await runOk((daemon) => daemon.status());
      expect(result).toEqual({ running: false, wasStale: true });
      // Should have cleaned up the stale state file
      expect(existsSync(statePath())).toBe(false);
    });

    test("reports stale state even when it can't remove the state file", async () => {
      await writeStaleState();
      await chmod(tempDir, 0o555);
      const result = await runOk((daemon) => daemon.status());
      expect(result).toEqual({ running: false, wasStale: true });
      expect(existsSync(statePath())).toBe(true);
    });

    test("treats a live process that isn't the recorded daemon as stale", async () => {
      // This test runner is alive, but it is not a shelf daemon.
      await writeState(process.pid, "deadbeef".repeat(4));
      const result = await runOk((daemon) => daemon.status());
      expect(result).toEqual({ running: false, wasStale: true });
    });

    test("treats the daemon as stale when its command line can't be read", async () => {
      await startFakeDaemon("exits");
      const result = await runOk((daemon) => daemon.status(), {
        spawner: (real) => (command) =>
          isPs(command) ? Effect.fail(failure("spawn")) : real(command),
      });
      expect(result).toEqual({ running: false, wasStale: true });
    });

    test("treats the daemon as stale when ps fails", async () => {
      await startFakeDaemon("exits");
      const result = await runOk((daemon) => daemon.status(), {
        spawner: (real) => (command) =>
          isPs(command)
            ? Effect.map(real(command), (handle) =>
                withHandle(handle, { exitCode: Effect.succeed(ExitCode(1)) }),
              )
            : real(command),
      });
      expect(result).toEqual({ running: false, wasStale: true });
    });

    test("returns running with details for a real daemon", async () => {
      const pid = await startRealDaemon();
      const result = await runOk((daemon) => daemon.status());
      expect(result.running).toBe(true);
      if (result.running) {
        expect(result.pid).toBe(pid);
        expect(result.uptime).toMatch(/^\d+s$/);
        expect(result.version).toBe(SHELF_VERSION);
      }
    }, 20_000);

    test.each([
      { ago: 5_500, uptime: "5s" },
      { ago: (3 * 60 + 4) * 1000 + 500, uptime: "3m 4s" },
      { ago: (2 * 60 + 5) * 60_000 + 500, uptime: "2h 5m" },
      { ago: (24 + 3) * 3_600_000 + 500, uptime: "1d 3h" },
    ])("shows an uptime of $uptime", async ({ ago, uptime }) => {
      const startedAt = new Date(Date.now() - ago).toISOString();
      const { pid } = await startFakeDaemon("exits", startedAt);
      const result = await runOk((daemon) => daemon.status());
      expect(result).toEqual({
        running: true,
        pid,
        uptime,
        startedAt,
        lastTickAt: Option.none(),
        version: "0.1.1",
      });
    });
  });

  describe("stop", () => {
    test("fails with DaemonNotRunningError when no state file", async () => {
      const error = await errorOf((daemon) => daemon.stop());
      expect(error._tag).toBe("DaemonNotRunningError");
    });

    test("fails with DaemonNotRunningError and clears the state when PID is dead", async () => {
      await writeStaleState();
      const error = await errorOf((daemon) => daemon.stop());
      expect(error._tag).toBe("DaemonNotRunningError");
      expect(existsSync(statePath())).toBe(false);
    });

    test("stops a real daemon, which clears its own state", async () => {
      const pid = await startRealDaemon();
      await runOk((daemon) => daemon.stop());
      expect(isAlive(pid)).toBe(false);
      expect(existsSync(statePath())).toBe(false);
    }, 20_000);

    test("clears the state file a stopped daemon left behind", async () => {
      const { pid } = await startFakeDaemon("exits");
      await runOk((daemon) => daemon.stop());
      expect(isAlive(pid)).toBe(false);
      expect(existsSync(statePath())).toBe(false);
    });

    test("keeps the state file of a daemon that has since taken over", async () => {
      await startFakeDaemon("hands-over");
      await runOk((daemon) => daemon.stop());
      const state = (await readJson(statePath())) as { token: string };
      expect(state.token).toBe("other");
    });

    test("fails with DaemonStillStoppingError when the daemon outlasts the stop timeout", async () => {
      process.env["SHELF_DAEMON_STOP_TIMEOUT_MS"] = "200";
      const { pid } = await startFakeDaemon("ignores");
      const error = await errorOf((daemon) => daemon.stop());
      expect(error).toMatchObject({ _tag: "DaemonStillStoppingError", pid });
      expect(isAlive(pid)).toBe(true);
      expect(existsSync(statePath())).toBe(true);
    });
  });

  describe("start", () => {
    test("fails with DaemonAlreadyRunningError when daemon is already running", async () => {
      const { pid } = await startFakeDaemon("exits");
      const error = await errorOf((daemon) => daemon.start());
      expect(error).toMatchObject({ _tag: "DaemonAlreadyRunningError", pid });
    });

    test("cleans up stale state and starts a real daemon in the shelf home", async () => {
      await writeStaleState();
      const pid = await startRealDaemon();
      expect(pid).not.toBe(999_999_999);
      const written = (await readJson(statePath())) as { pid: number };
      expect(written.pid).toBe(pid);
    }, 20_000);

    test("fails with DaemonStartError when the daemon exits during startup", async () => {
      const entry = await writeEntry("exits", "console.log('bad start'); process.exit(3);");
      const error = await errorOf((daemon) => daemon.start(), { entry });
      expect(error._tag).toBe("DaemonStartError");
      expect(messageOf(error)).toContain("daemon exited during startup");
      // The daemon's output went to the log.
      expect(await readFile(logPath(), "utf8")).toContain("bad start");
    });

    test("fails with DaemonStartError and kills a daemon that never reports running", async () => {
      const entry = await writeLingeringEntry();
      const error = await errorOf((daemon) => daemon.start(), { entry });
      expect(error._tag).toBe("DaemonStartError");
      expect(messageOf(error)).toContain("daemon did not report running within 10s");
      const pid = await lingeringPid();
      await waitUntil(() => !isAlive(pid));
    }, 25_000);

    test("launches the daemon.mjs next to the service code by default", async () => {
      // Run from source there is no daemon.mjs beside daemon-service.ts, so the
      // daemon fails to load it and exits.
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          return yield* (yield* DaemonService).start();
        }).pipe(
          Effect.provide(
            DaemonService.layer.pipe(Layer.provide(configLayer()), Layer.provide(PlatformLayer)),
          ),
        ),
      );
      expect(Exit.isFailure(exit) && String(exit.cause)).toContain("daemon exited during startup");
      const log = await readFile(logPath(), "utf8");
      expect(log).toContain(join("src", "domain", "daemon", "daemon.mjs"));
    });

    test("rotates a log over 5 MB before starting", async () => {
      await writeFile(logPath(), "x".repeat(5_242_881));
      const entry = await writeEntry("exits", "process.exit(1);");
      await errorOf((daemon) => daemon.start(), { entry });
      expect((await stat(`${logPath()}.1`)).size).toBe(5_242_881);
      expect(existsSync(logPath()) ? (await stat(logPath())).size : 0).toBeLessThan(5_242_881);
    });

    test("keeps a log of exactly 5 MB", async () => {
      await writeFile(logPath(), "x".repeat(5_242_880));
      const entry = await writeEntry("exits", "process.exit(1);");
      await errorOf((daemon) => daemon.start(), { entry });
      expect(existsSync(`${logPath()}.1`)).toBe(false);
    });

    test("fails with DaemonStartError when the daemon can't be spawned", async () => {
      const error = await errorOf((daemon) => daemon.start(), {
        spawner: () => () => Effect.fail(failure("spawn")),
      });
      expect(error._tag).toBe("DaemonStartError");
      expect(messageOf(error)).toContain("Failed to spawn daemon process");
    });

    test("fails with DaemonStartError when the daemon can't be detached", async () => {
      const entry = await writeEntry("exits", "process.exit(1);");
      const error = await errorOf((daemon) => daemon.start(), {
        entry,
        spawner: (real) => (command) =>
          Effect.map(real(command), (handle) =>
            withHandle(handle, { unref: Effect.fail(failure("unref")) }),
          ),
      });
      expect(error._tag).toBe("DaemonStartError");
      expect(messageOf(error)).toContain("Failed to spawn daemon process");
    });

    test("treats a daemon whose run state can't be checked as exited", async () => {
      const entry = await writeLingeringEntry();
      const error = await errorOf((daemon) => daemon.start(), {
        entry,
        spawner: (real) => (command) =>
          isPs(command)
            ? real(command)
            : Effect.map(real(command), (handle) =>
                withHandle(handle, { isRunning: Effect.fail(failure("isRunning")) }),
              ),
      });
      await lingeringPid();
      expect(messageOf(error)).toContain("daemon exited during startup");
    });
  });

  describe("runForeground", () => {
    test("fails with DaemonAlreadyRunningError when a daemon is running", async () => {
      const { pid } = await startFakeDaemon("exits");
      const error = await errorOf((daemon) => daemon.runForeground());
      expect(error).toMatchObject({ _tag: "DaemonAlreadyRunningError", pid });
    });

    test("clears stale state, then returns when the daemon exits", async () => {
      await writeStaleState();
      const entry = await writeEntry("exits", "process.exit(0);");
      await runOk((daemon) => daemon.runForeground(), { entry });
      expect(existsSync(statePath())).toBe(false);
    });

    test("fails with DaemonStartError when the daemon can't be spawned", async () => {
      const error = await errorOf((daemon) => daemon.runForeground(), {
        spawner: () => () => Effect.fail(failure("spawn")),
      });
      expect(error._tag).toBe("DaemonStartError");
      expect(messageOf(error)).toContain("Failed to spawn daemon process");
    });

    test("asks the daemon to stop when interrupted", async () => {
      const entry = await writeLingeringEntry();
      const fiber = Effect.runFork(
        Effect.gen(function* () {
          return yield* (yield* DaemonService).runForeground();
        }).pipe(Effect.provide(createTestLayer({ entry }))),
      );
      const pid = await lingeringPid();
      await Effect.runPromise(Fiber.interrupt(fiber));
      expect(existsSync(join(tempDir, "entries", "stopped"))).toBe(true);
      await waitUntil(() => !isAlive(pid));
    });
  });

  describe("logs", () => {
    test("returns 'No daemon logs found.' when no log file", async () => {
      expect(await runOk((daemon) => daemon.logs(50))).toBe("No daemon logs found.");
    });

    test("returns 'No daemon logs found.' when the log is empty", async () => {
      await writeFile(logPath(), "");
      expect(await runOk((daemon) => daemon.logs(50))).toBe("No daemon logs found.");
    });

    test("returns 'No daemon logs found.' when the log can't be read", async () => {
      await mkdir(logPath());
      expect(await runOk((daemon) => daemon.logs(50))).toBe("No daemon logs found.");
    });

    test("returns exactly the last N lines of the log", async () => {
      const lines = Array.from({ length: 100 }, (_, i) => `[2024-01-01] Log line ${i + 1}`);
      await writeFile(logPath(), `${lines.join("\n")}\n`);
      const result = await runOk((daemon) => daemon.logs(10));
      expect(result.split("\n")).toEqual(lines.slice(-10));
    });

    test("returns all lines when fewer than requested", async () => {
      await writeFile(logPath(), "line 1\nline 2\nline 3\n");
      expect(await runOk((daemon) => daemon.logs(50))).toBe("line 1\nline 2\nline 3");
    });
  });
});
