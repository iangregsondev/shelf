import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonService } from "../../../src/domain/daemon/daemon-service";
import { DaemonState, encodeDaemonState } from "../../../src/domain/daemon/daemon-schema";
import { ConfigService } from "../../../src/domain/config/config-service";
import { defaultConfig } from "../../../src/domain/config/config-schema";
import { stopDaemonIn } from "../../helpers/daemon";
import { SHELF_VERSION } from "../../../src/version";

describe("DaemonService", () => {
	let tempDir: string;
	let startedPids: number[] = [];

	const createTestLayer = () => {
		const configLayer = Layer.succeed(
			ConfigService,
			ConfigService.of({
				load: () => Effect.succeed({ version: 1 as const, syncIntervalMinutes: 60, repos: [] }),
				update: (fn) => {
					const result = fn(defaultConfig);
					return Effect.isEffect(result) ? result : Effect.succeed(result);
				},
				ensureDirectories: () => Effect.void,
				repoPath: (alias: string) => join(tempDir, "repos", alias),
				configDir: tempDir,
				reposDir: join(tempDir, "repos"),
				configPath: join(tempDir, "config.json"),
			}),
		);
		return DaemonService.layer.pipe(Layer.provide(configLayer));
	};

	/** Starts a real daemon in this test's shelf home and records its PID for cleanup. */
	const startRealDaemon = async (): Promise<number> => {
		// The daemon child inherits SHELF_HOME, so point it at this test's shelf home.
		const previousHome = process.env["SHELF_HOME"];
		process.env["SHELF_HOME"] = tempDir;
		try {
			const pid = await Effect.runPromise(
				Effect.gen(function* () {
					const daemon = yield* DaemonService;
					return yield* daemon.start();
				}).pipe(Effect.provide(createTestLayer())),
			);
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
		// Runs even when a test fails: never leave a daemon behind.
		await stopDaemonIn(tempDir, startedPids);
		startedPids = [];
		await rm(tempDir, { recursive: true, force: true });
	});

	describe("status", () => {
		test("returns not running when no state file exists", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const daemon = yield* DaemonService;
					return yield* daemon.status();
				}).pipe(Effect.provide(createTestLayer())),
			);
			expect(result.running).toBe(false);
		});

		test("returns not running when PID is dead (stale state)", async () => {
			const state = new DaemonState({
				pid: 999_999_999,
				token: "deadbeef".repeat(4),
				startedAt: new Date().toISOString(),
				lastTickAt: Option.none(),
				version: "0.1.1",
			});
			const encoded = encodeDaemonState(state);
			await writeFile(join(tempDir, "daemon.json"), JSON.stringify(encoded, null, "\t"));

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const daemon = yield* DaemonService;
					return yield* daemon.status();
				}).pipe(Effect.provide(createTestLayer())),
			);
			expect(result.running).toBe(false);
			// Should have cleaned up the stale state file
			const exists = await Bun.file(join(tempDir, "daemon.json")).exists();
			expect(exists).toBe(false);
		});

		test("returns running with details for a real daemon", async () => {
			const pid = await startRealDaemon();

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const daemon = yield* DaemonService;
					return yield* daemon.status();
				}).pipe(Effect.provide(createTestLayer())),
			);
			expect(result.running).toBe(true);
			if (result.running) {
				expect(result.pid).toBe(pid);
				expect(result.uptime).toMatch(/\d/);
				expect(result.version).toBe(SHELF_VERSION);
			}
		}, 20_000);
	});

	describe("stop", () => {
		test("fails with DaemonNotRunningError when no state file", async () => {
			const exit = await Effect.runPromiseExit(
				Effect.gen(function* () {
					const daemon = yield* DaemonService;
					yield* daemon.stop();
				}).pipe(Effect.provide(createTestLayer())),
			);
			expect(Exit.isFailure(exit)).toBe(true);
		});

		test("fails with DaemonNotRunningError when PID is dead", async () => {
			const state = new DaemonState({
				pid: 999_999_999,
				token: "deadbeef".repeat(4),
				startedAt: new Date().toISOString(),
				lastTickAt: Option.none(),
				version: "0.1.1",
			});
			const encoded = encodeDaemonState(state);
			await writeFile(join(tempDir, "daemon.json"), JSON.stringify(encoded, null, "\t"));

			const exit = await Effect.runPromiseExit(
				Effect.gen(function* () {
					const daemon = yield* DaemonService;
					yield* daemon.stop();
				}).pipe(Effect.provide(createTestLayer())),
			);
			expect(Exit.isFailure(exit)).toBe(true);
		});
	});

	describe("start", () => {
		test("fails with DaemonAlreadyRunningError when daemon is already running", async () => {
			await startRealDaemon();

			const exit = await Effect.runPromiseExit(
				Effect.gen(function* () {
					const daemon = yield* DaemonService;
					yield* daemon.start();
				}).pipe(Effect.provide(createTestLayer())),
			);
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				expect(String(exit.cause)).toContain("DaemonAlreadyRunningError");
			}
		}, 20_000);

		test("cleans up stale state and starts a real daemon in the shelf home", async () => {
			// Write state with dead PID
			const state = new DaemonState({
				pid: 999_999_999,
				token: "deadbeef".repeat(4),
				startedAt: new Date().toISOString(),
				lastTickAt: Option.none(),
				version: "0.1.1",
			});
			const encoded = encodeDaemonState(state);
			await writeFile(join(tempDir, "daemon.json"), JSON.stringify(encoded, null, "\t"));

			const pid = await startRealDaemon();

			expect(pid).not.toBe(999_999_999);
			const written = (await Bun.file(join(tempDir, "daemon.json")).json()) as { pid: number };
			expect(written.pid).toBe(pid);
		}, 20_000);
	});

	describe("logs", () => {
		test("returns 'No daemon logs found.' when no log file", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const daemon = yield* DaemonService;
					return yield* daemon.logs(50);
				}).pipe(Effect.provide(createTestLayer())),
			);
			expect(result).toBe("No daemon logs found.");
		});

		test("returns last N lines from log file", async () => {
			const lines = Array.from({ length: 100 }, (_, i) => `[2024-01-01] Log line ${i + 1}`);
			await writeFile(join(tempDir, "daemon.log"), lines.join("\n"));

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const daemon = yield* DaemonService;
					return yield* daemon.logs(10);
				}).pipe(Effect.provide(createTestLayer())),
			);

			const outputLines = result.split("\n").filter((l) => l.length > 0);
			expect(outputLines.length).toBeLessThanOrEqual(10);
			expect(result).toContain("Log line 100");
		});

		test("returns all lines when fewer than requested", async () => {
			await writeFile(join(tempDir, "daemon.log"), "line 1\nline 2\nline 3");

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const daemon = yield* DaemonService;
					return yield* daemon.logs(50);
				}).pipe(Effect.provide(createTestLayer())),
			);

			expect(result).toContain("line 1");
			expect(result).toContain("line 3");
		});
	});
});
