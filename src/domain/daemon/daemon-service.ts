import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import { FileSystem } from "effect/FileSystem";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import { ConfigService } from "../config/config-service";
import { SyncService } from "../sync/sync-service";
import { DaemonState, encodeDaemonState, decodeDaemonState } from "./daemon-schema";
import {
  DaemonAlreadyRunningError,
  DaemonNotRunningError,
  DaemonStartError,
  DaemonStillStoppingError,
} from "./daemon-errors";
import {
  daemonStatePath,
  daemonLogPath,
  generateToken,
  daemonTokenFromArgs,
  isDaemonCommandLine,
} from "./daemon-utils";
import { defaultConfig } from "../config/config-schema";
import { parseSyncInterval } from "../config/config-utils";
import { isProcessAlive } from "../config/state-file-store";
import { SHELF_VERSION } from "../../version";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const LOG_MAX_BYTES = 5_242_880; // 5 MB
/** How long `start` waits for the daemon to report itself running. */
const START_TIMEOUT_MS = 10_000;
/**
 * How long `stop` waits for the daemon to finish its current step. The daemon
 * is never killed mid-step; `SHELF_DAEMON_STOP_TIMEOUT_MS` overrides the wait.
 */
const stopTimeoutMs = (): number => {
  const override = Number(process.env["SHELF_DAEMON_STOP_TIMEOUT_MS"]);
  return Number.isInteger(override) && override > 0 ? override : 30_000;
};
const POLL_MS = 50;
/**
 * The daemon process's entry point, the built `daemon.mjs`; status and stop
 * recognise it by this file. Bundled, this code sits in `dist` next to it. Run
 * from source (the tests), it uses the one built into the repo's `dist`.
 */
const DAEMON_ENTRY = fileURLToPath(
  new URL(
    import.meta.url.endsWith(".ts") ? "../../../dist/daemon.mjs" : "./daemon.mjs",
    import.meta.url,
  ),
);
/** The command line of a daemon started with `token`. */
const daemonCommand = (token: string): string[] => [
  process.execPath,
  DAEMON_ENTRY,
  "--token",
  token,
];

/**
 * The background daemon's launch command: `sh` points the daemon's stdout and
 * stderr at the log, appending so the log survives restarts until rotated,
 * then `exec`s the daemon so it keeps the same pid and command line.
 */
const backgroundDaemonCommand = (token: string, logPath: string): ChildProcess.Command =>
  ChildProcess.make(
    "/bin/sh",
    ["-c", 'log="$1"; shift; exec "$@" >>"$log" 2>&1', "sh", logPath, ...daemonCommand(token)],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
      env: { SHELF_DAEMON: "1" },
      extendEnv: true,
    },
  );

/** The command line of a running process, or undefined if there is no such process. */
const commandLineOf = (
  spawner: ChildProcessSpawner["Service"],
  pid: number,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const proc = yield* spawner.spawn(
      ChildProcess.make("ps", ["-ww", "-o", "command=", "-p", String(pid)], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        detached: false,
      }),
    );
    const [stdout, exitCode] = yield* Effect.all(
      [Stream.mkString(Stream.decodeText(proc.stdout)), proc.exitCode],
      { concurrency: "unbounded" },
    );
    return exitCode === 0 ? stdout.trim() : undefined;
  }).pipe(
    Effect.scoped,
    Effect.catch(() => Effect.succeed(undefined)),
  );

/** The recorded daemon state, or null when there is none or it can't be read. */
const readStateFile = (fs: FileSystem, path: string): Effect.Effect<DaemonState | null> =>
  Effect.gen(function* () {
    if (!(yield* fs.exists(path))) return null;
    const text = yield* fs.readFileString(path);
    return yield* Effect.try(() => decodeDaemonState(JSON.parse(text)));
  }).pipe(Effect.catch(() => Effect.succeed(null)));

const formatUptime = (startedAt: string): string => {
  const ms = Date.now() - new Date(startedAt).getTime();
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
};

export class DaemonService extends Context.Service<DaemonService>()(
  "shelf/domain/daemon/DaemonService",
  {
    make: Effect.gen(function* () {
      const fs = yield* FileSystem;
      const spawner = yield* ChildProcessSpawner;
      const config = yield* ConfigService;
      const statePath = daemonStatePath(config.shelfHome);
      const logPath = daemonLogPath(config.shelfHome);

      const readState = (): Effect.Effect<DaemonState | null> => readStateFile(fs, statePath);

      const removeState = (): Effect.Effect<void> =>
        fs.remove(statePath, { force: true }).pipe(Effect.catch(() => Effect.void));

      /** Whether `pid` is alive and is the shelf daemon started with `token`. */
      const isShelfDaemon = (pid: number, token: string): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          if (!isProcessAlive(pid)) return false;
          const commandLine = yield* commandLineOf(spawner, pid);
          return commandLine !== undefined && isDaemonCommandLine(commandLine, token);
        });

      const verifyDaemon = (
        state: DaemonState | null,
      ): Effect.Effect<{ alive: true; state: DaemonState } | { alive: false }> =>
        Effect.gen(function* () {
          if (!state) return { alive: false } as const;
          if (!(yield* isShelfDaemon(state.pid, state.token))) return { alive: false } as const;
          return { alive: true, state } as const;
        });

      return {
        start: Effect.fn("DaemonService.start")(function* () {
          yield* config.ensureDirectories();
          const existing = yield* readState();
          const check = yield* verifyDaemon(existing);
          if (check.alive) {
            return yield* Effect.fail(new DaemonAlreadyRunningError({ pid: check.state.pid }));
          }
          if (existing) {
            yield* removeState();
          }

          // Rotate log if too large
          yield* Effect.gen(function* () {
            const info = yield* fs.stat(logPath);
            if (Number(info.size) > LOG_MAX_BYTES) {
              yield* fs.rename(logPath, `${logPath}.1`);
            }
          }).pipe(Effect.catch(() => Effect.void));

          const token = generateToken();
          const spawnError = (err: unknown): DaemonStartError =>
            new DaemonStartError({ message: `Failed to spawn daemon process: ${String(err)}` });
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const child = yield* spawner
                .spawn(backgroundDaemonCommand(token, logPath))
                .pipe(Effect.mapError(spawnError));
              // Unreferenced, the daemon outlives this process and the scope.
              yield* child.unref.pipe(Effect.mapError(spawnError));

              // Return only once the daemon has recorded itself as running.
              const deadline = Date.now() + START_TIMEOUT_MS;
              while (true) {
                const state = yield* readState();
                if (state && state.token === token && (yield* isShelfDaemon(state.pid, token))) {
                  return state.pid;
                }
                const running = yield* child.isRunning.pipe(Effect.orElseSucceed(() => false));
                if (!running) {
                  return yield* Effect.fail(
                    new DaemonStartError({
                      message: `daemon exited during startup; see \`shelf daemon logs\``,
                    }),
                  );
                }
                if (Date.now() > deadline) {
                  yield* child.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore);
                  return yield* Effect.fail(
                    new DaemonStartError({
                      message: `daemon did not report running within ${START_TIMEOUT_MS / 1000}s; see \`shelf daemon logs\``,
                    }),
                  );
                }
                yield* Effect.sleep(POLL_MS);
              }
            }),
          );
        }),

        /**
         * Runs the daemon attached to this terminal: the same daemon process
         * `start` spawns, so status and stop recognise it, with its output
         * here instead of the log. Returns when the daemon exits; if this
         * process is interrupted (Ctrl+C), asks the daemon to stop and waits.
         */
        runForeground: Effect.fn("DaemonService.runForeground")(function* () {
          yield* config.ensureDirectories();
          const existing = yield* readState();
          const check = yield* verifyDaemon(existing);
          if (check.alive) {
            return yield* new DaemonAlreadyRunningError({ pid: check.state.pid });
          }
          if (existing) {
            yield* removeState();
          }
          const token = generateToken();
          const [command, ...args] = daemonCommand(token);
          yield* Effect.scoped(
            Effect.gen(function* () {
              const child = yield* spawner
                .spawn(
                  ChildProcess.make(command ?? process.execPath, args, {
                    stdin: "inherit",
                    stdout: "inherit",
                    stderr: "inherit",
                    detached: false,
                    env: { SHELF_DAEMON: "1" },
                    extendEnv: true,
                  }),
                )
                .pipe(
                  Effect.mapError(
                    (err) =>
                      new DaemonStartError({
                        message: `Failed to spawn daemon process: ${String(err)}`,
                      }),
                  ),
                );
              // On interrupt, SIGTERM the daemon and wait for it to finish its step.
              yield* child.exitCode.pipe(
                Effect.onInterrupt(() => child.kill({ killSignal: "SIGTERM" }).pipe(Effect.ignore)),
                Effect.ignore,
              );
            }),
          );
        }),

        stop: Effect.fn("DaemonService.stop")(function* () {
          const existing = yield* readState();
          const check = yield* verifyDaemon(existing);
          if (!check.alive) {
            if (existing) yield* removeState();
            return yield* Effect.fail(new DaemonNotRunningError());
          }
          const { pid, token } = check.state;
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            // already dead
          }
          // The daemon finishes its current step, removes its state file and
          // exits. Killing it mid-step could leave a repo half-synced, so a
          // daemon still busy at the deadline is left running.
          const deadline = Date.now() + stopTimeoutMs();
          while (isProcessAlive(pid) && Date.now() < deadline) {
            yield* Effect.sleep(POLL_MS);
          }
          if (yield* isShelfDaemon(pid, token)) {
            return yield* new DaemonStillStoppingError({ pid });
          }
          const current = yield* readState();
          if (current && current.token === token) yield* removeState();
        }),

        status: Effect.fn("DaemonService.status")(function* () {
          const existing = yield* readState();
          if (!existing) {
            return { running: false as const };
          }
          const check = yield* verifyDaemon(existing);
          if (!check.alive) {
            yield* removeState();
            return { running: false as const, wasStale: true };
          }
          return {
            running: true as const,
            pid: check.state.pid,
            uptime: formatUptime(check.state.startedAt),
            startedAt: check.state.startedAt,
            lastTickAt: check.state.lastTickAt,
            version: check.state.version,
          };
        }),

        logs: Effect.fn("DaemonService.logs")(function* (lines: number) {
          const content = yield* Effect.gen(function* () {
            if (!(yield* fs.exists(logPath))) return "";
            return yield* fs.readFileString(logPath);
          }).pipe(Effect.catch(() => Effect.succeed("")));

          if (!content) return "No daemon logs found.";
          const allLines = content.split("\n");
          return allLines.slice(-lines).join("\n");
        }),
      };
    }),
  },
) {
  static layer = Layer.effect(this, this.make);
}

// --- Daemon loop program (runs in subprocess) ---

const appendLog = (message: string): void => {
  const timestamp = new Date().toISOString();
  // The daemon logs to stdout, which is redirected to the log file.
  console.log(`[${timestamp}] ${message}`);
};

const writeDaemonState = (
  fs: FileSystem,
  path: string,
  token: string,
  startedAt: string,
  lastTickAt: Option.Option<string>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const state = new DaemonState({
      pid: process.pid,
      token,
      startedAt,
      lastTickAt,
      version: SHELF_VERSION,
    });
    const encoded = encodeDaemonState(state);
    const tmpPath = `${path}.tmp`;
    // Create the folder if it is missing, as writes always have.
    yield* fs.makeDirectory(dirname(tmpPath), { recursive: true });
    yield* fs.writeFileString(tmpPath, JSON.stringify(encoded, null, "\t"));
    yield* fs.rename(tmpPath, path);
  }).pipe(Effect.catch(() => Effect.void));

/** Removes the state file, unless another daemon has since recorded itself there. */
const cleanupState = (fs: FileSystem, path: string, token: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (yield* fs.exists(path)) {
      const text = yield* fs.readFileString(path);
      const recorded = yield* Effect.try(() => decodeDaemonState(JSON.parse(text)));
      if (recorded.token !== token) return;
    }
    yield* fs.remove(path, { force: true });
  }).pipe(Effect.catch(() => Effect.void));

/** The interval to sleep between syncs; falls back to the default for a bad hand-edited value. */
const syncInterval = (minutes: number): number =>
  parseSyncInterval(String(minutes)) ?? defaultConfig.syncIntervalMinutes;

// Runs as the daemon process. The runtime interrupts this program on SIGTERM
// or SIGINT; each sync step is uninterruptible, so the daemon finishes the
// step it is on, then removes its state file and exits.
export const daemonProgram = Effect.gen(function* () {
  const fs = yield* FileSystem;
  const cfg = yield* ConfigService;
  const sync = yield* SyncService;
  const path = daemonStatePath(cfg.shelfHome);
  const token = daemonTokenFromArgs(process.argv) ?? generateToken();

  const startedAt = new Date().toISOString();
  appendLog("Daemon started");
  yield* writeDaemonState(fs, path, token, startedAt, Option.none());

  const step = Effect.gen(function* () {
    const config = yield* cfg.load().pipe(Effect.catch(() => Effect.succeed(null)));
    if (!config) {
      appendLog("Failed to load config, retrying in 60s");
      return 1;
    }

    const intervalMinutes = syncInterval(config.syncIntervalMinutes);
    appendLog(`Starting sync cycle (interval: ${intervalMinutes}m)`);

    yield* sync.syncAll().pipe(
      Effect.tap(({ failures }) =>
        Effect.sync(() => {
          for (const failure of failures) {
            appendLog(`Sync failed for "${failure.alias}": ${String(failure.error)}`);
          }
        }),
      ),
      Effect.catch((error: unknown) => {
        appendLog(`Sync cycle failed: ${String(error)}`);
        return Effect.void;
      }),
    );

    appendLog("Sync cycle complete");
    yield* writeDaemonState(fs, path, token, startedAt, Option.some(new Date().toISOString()));
    return intervalMinutes;
  });

  yield* Effect.forever(
    Effect.gen(function* () {
      const minutes = yield* Effect.uninterruptible(step);
      yield* Effect.sleep(Duration.minutes(minutes));
    }),
  ).pipe(
    Effect.onInterrupt(() =>
      Effect.sync(() => appendLog("Received stop signal, shutting down...")),
    ),
    Effect.ensuring(
      cleanupState(fs, path, token).pipe(
        Effect.andThen(Effect.sync(() => appendLog("Daemon stopped"))),
      ),
    ),
  );
});
