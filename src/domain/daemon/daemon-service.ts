import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Context from "effect/Context";
import { closeSync, openSync } from "node:fs";
import { ConfigService } from "../config/config-service";
import { SyncService } from "../sync/sync-service";
import { DaemonState, encodeDaemonState, decodeDaemonState } from "./daemon-schema";
import {
	DaemonAlreadyRunningError,
	DaemonNotRunningError,
	DaemonStartError,
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

const LOG_MAX_BYTES = 5_242_880; // 5 MB
/** How long `start` waits for the daemon to report itself running. */
const START_TIMEOUT_MS = 10_000;
/** How long `stop` waits for the daemon to finish its current step before SIGKILL. */
const STOP_TIMEOUT_MS = 30_000;
const POLL_MS = 50;

/** The command line of a running process, or undefined if there is no such process. */
const commandLineOf = (pid: number): string | undefined => {
	try {
		const result = Bun.spawnSync(["ps", "-ww", "-o", "command=", "-p", String(pid)], {
			stdout: "pipe",
			stderr: "ignore",
		});
		if (result.exitCode !== 0) return undefined;
		return result.stdout.toString().trim();
	} catch {
		return undefined;
	}
};

/** Whether `pid` is alive and is the shelf daemon started with `token`. */
const isShelfDaemon = (pid: number, token: string): boolean => {
	if (!isProcessAlive(pid)) return false;
	const commandLine = commandLineOf(pid);
	return commandLine !== undefined && isDaemonCommandLine(commandLine, token);
};

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
			const config = yield* ConfigService;
			const statePath = daemonStatePath(config.shelfHome);
			const logPath = daemonLogPath(config.shelfHome);

			const readState = (): Effect.Effect<DaemonState | null> =>
				Effect.tryPromise({
					try: async () => {
						const file = Bun.file(statePath);
						if (!(await file.exists())) return null;
						const raw = await file.json();
						return decodeDaemonState(raw);
					},
					catch: () => null,
				}).pipe(Effect.catch(() => Effect.succeed(null)));

			const removeState = (): Effect.Effect<void> =>
				Effect.tryPromise({
					try: async () => {
						const { rm } = await import("node:fs/promises");
						await rm(statePath, { force: true });
					},
					catch: () => undefined,
				}).pipe(Effect.catch(() => Effect.void));

			const verifyDaemon = (
				state: DaemonState | null,
			): { alive: true; state: DaemonState } | { alive: false } => {
				if (!state) return { alive: false };
				if (!isShelfDaemon(state.pid, state.token)) return { alive: false };
				return { alive: true, state };
			};

			return {
				start: Effect.fn("DaemonService.start")(function* () {
					yield* config.ensureDirectories();
					const existing = yield* readState();
					const check = verifyDaemon(existing);
					if (check.alive) {
						return yield* Effect.fail(new DaemonAlreadyRunningError({ pid: check.state.pid }));
					}
					if (existing) {
						yield* removeState();
					}

					// Rotate log if too large
					yield* Effect.tryPromise({
						try: async () => {
							const logFile = Bun.file(logPath);
							if ((await logFile.exists()) && logFile.size > LOG_MAX_BYTES) {
								const { rename } = await import("node:fs/promises");
								await rename(logPath, `${logPath}.1`);
							}
						},
						catch: () => undefined,
					}).pipe(Effect.catch(() => Effect.void));

					const token = generateToken();
					const daemonEntry = new URL("../../startup/daemon.ts", import.meta.url).pathname;
					const child = yield* Effect.try({
						try: () => {
							// Append, never truncate: the log survives restarts until rotated.
							const logFd = openSync(logPath, "a");
							try {
								const proc = Bun.spawn([process.execPath, daemonEntry, "--token", token], {
									stdio: ["ignore", logFd, logFd],
									detached: true,
									env: { ...process.env, SHELF_DAEMON: "1" },
								});
								proc.unref();
								return proc;
							} finally {
								closeSync(logFd);
							}
						},
						catch: (err) =>
							new DaemonStartError({ message: `Failed to spawn daemon process: ${err}` }),
					});

					// Return only once the daemon has recorded itself as running.
					const deadline = Date.now() + START_TIMEOUT_MS;
					while (true) {
						const state = yield* readState();
						if (state && state.token === token && isShelfDaemon(state.pid, token)) {
							return state.pid;
						}
						if (child.exitCode !== null || child.signalCode !== null) {
							return yield* Effect.fail(
								new DaemonStartError({
									message: `daemon exited during startup; see \`shelf daemon logs\``,
								}),
							);
						}
						if (Date.now() > deadline) {
							child.kill("SIGKILL");
							return yield* Effect.fail(
								new DaemonStartError({
									message: `daemon did not report running within ${START_TIMEOUT_MS / 1000}s; see \`shelf daemon logs\``,
								}),
							);
						}
						yield* Effect.sleep(POLL_MS);
					}
				}),

				stop: Effect.fn("DaemonService.stop")(function* () {
					const existing = yield* readState();
					const check = verifyDaemon(existing);
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
					// The daemon finishes its current step, removes its state file and exits.
					const deadline = Date.now() + STOP_TIMEOUT_MS;
					while (isProcessAlive(pid) && Date.now() < deadline) {
						yield* Effect.sleep(POLL_MS);
					}
					if (isShelfDaemon(pid, token)) {
						try {
							process.kill(pid, "SIGKILL");
						} catch {
							// already dead
						}
					}
					const current = yield* readState();
					if (current && current.token === token) yield* removeState();
				}),

				status: Effect.fn("DaemonService.status")(function* () {
					const existing = yield* readState();
					if (!existing) {
						return { running: false as const };
					}
					const check = verifyDaemon(existing);
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
					const content = yield* Effect.tryPromise({
						try: async () => {
							const file = Bun.file(logPath);
							if (!(await file.exists())) return "";
							return await file.text();
						},
						catch: () => "",
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
	// eslint-disable-next-line no-console -- daemon logs to stdout which is redirected to log file
	console.log(`[${timestamp}] ${message}`);
};

const writeDaemonState = (
	path: string,
	token: string,
	startedAt: string,
	lastTickAt: Option.Option<string>,
): Effect.Effect<void> =>
	Effect.tryPromise({
		try: async () => {
			const state = new DaemonState({
				pid: process.pid,
				token,
				startedAt,
				lastTickAt,
				version: SHELF_VERSION,
			});
			const encoded = encodeDaemonState(state);
			const tmpPath = `${path}.tmp`;
			await Bun.write(tmpPath, JSON.stringify(encoded, null, "\t"));
			const { rename } = await import("node:fs/promises");
			await rename(tmpPath, path);
		},
		catch: () => undefined,
	}).pipe(Effect.catch(() => Effect.void));

/** Removes the state file, unless another daemon has since recorded itself there. */
const cleanupState = (path: string, token: string): Effect.Effect<void> =>
	Effect.tryPromise({
		try: async () => {
			const file = Bun.file(path);
			if (await file.exists()) {
				const recorded = decodeDaemonState(await file.json());
				if (recorded.token !== token) return;
			}
			const { rm } = await import("node:fs/promises");
			await rm(path, { force: true });
		},
		catch: () => undefined,
	}).pipe(Effect.catch(() => Effect.void));

/** The interval to sleep between syncs; falls back to the default for a bad hand-edited value. */
const syncInterval = (minutes: number): number =>
	parseSyncInterval(String(minutes)) ?? defaultConfig.syncIntervalMinutes;

// Runs as the daemon process. The runtime interrupts this program on SIGTERM
// or SIGINT; each sync step is uninterruptible, so the daemon finishes the
// step it is on, then removes its state file and exits.
export const daemonProgram = Effect.gen(function* () {
	const cfg = yield* ConfigService;
	const sync = yield* SyncService;
	const path = daemonStatePath(cfg.shelfHome);
	const token = daemonTokenFromArgs(process.argv) ?? generateToken();

	const startedAt = new Date().toISOString();
	appendLog("Daemon started");
	yield* writeDaemonState(path, token, startedAt, Option.none());

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
				appendLog(`Sync cycle failed: ${error}`);
				return Effect.void;
			}),
		);

		appendLog("Sync cycle complete");
		yield* writeDaemonState(path, token, startedAt, Option.some(new Date().toISOString()));
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
			cleanupState(path, token).pipe(
				Effect.andThen(Effect.sync(() => appendLog("Daemon stopped"))),
			),
		),
	);
});
