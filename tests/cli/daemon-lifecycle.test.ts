// The daemon's lifecycle against a real daemon process in a temp shelf home.
// Every test stops whatever it started in afterEach, even when it fails.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { stopDaemonIn } from "../helpers/daemon";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";

let shelf: ShelfSandbox;
let otherPids: number[] = [];

const statePath = () => join(shelf.home, "daemon.json");
const logPath = () => join(shelf.home, "daemon.log");

const readState = async (): Promise<{ pid: number; token: string } | undefined> => {
	try {
		return (await Bun.file(statePath()).json()) as { pid: number; token: string };
	} catch {
		return undefined;
	}
};

const isAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const waitFor = async (check: () => Promise<boolean> | boolean, ms = 10_000): Promise<boolean> => {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await check()) return true;
		await Bun.sleep(50);
	}
	return false;
};

/** Starts the daemon and records its PID so cleanup kills it even if the state file goes. */
const startDaemon = async (): Promise<number> => {
	const result = await shelf.run(["daemon", "start"]);
	expect(result.exitCode).toBe(0);
	const state = await readState();
	expect(state).toBeDefined();
	otherPids.push(state!.pid);
	return state!.pid;
};

/** A live process that is not the shelf daemon. */
const spawnOtherProcess = (): number => {
	const proc = Bun.spawn(["sleep", "60"], { stdio: ["ignore", "ignore", "ignore"] });
	otherPids.push(proc.pid);
	return proc.pid;
};

const writeState = async (pid: number, token: string): Promise<void> => {
	await Bun.write(
		statePath(),
		JSON.stringify({ pid, token, startedAt: new Date().toISOString(), version: "0.0.0" }),
	);
};

beforeEach(async () => {
	shelf = await createShelfSandbox();
	otherPids = [];
});

afterEach(async () => {
	try {
		await stopDaemonIn(shelf.home, otherPids);
	} finally {
		await shelf.cleanup();
	}
});

describe("daemon start", () => {
	test("returns once the daemon is running, and status sees it", async () => {
		const started = Date.now();
		const result = await shelf.run(["daemon", "start"]);
		expect(result.exitCode).toBe(0);
		expect(Date.now() - started).toBeLessThan(10_000);

		const state = await readState();
		expect(state).toBeDefined();
		otherPids.push(state!.pid);
		expect(isAlive(state!.pid)).toBe(true);
		expect(result.stdout).toContain(`PID: ${state!.pid}`);

		const status = await shelf.run(["daemon", "status"]);
		expect(status.exitCode).toBe(0);
		expect(status.stdout).toContain("Daemon is running");
		expect(status.stdout).toContain(String(state!.pid));
	}, 20_000);

	test("a second start reports the daemon already running", async () => {
		const pid = await startDaemon();
		const again = await shelf.run(["daemon", "start"]);
		expect(again.exitCode).toBe(1);
		expect(again.stderr).toContain(`already running (PID: ${pid})`);
	}, 20_000);
});

describe("daemon identity", () => {
	test("status reports not running when the recorded PID is another process", async () => {
		const other = spawnOtherProcess();
		await writeState(other, "a".repeat(32));

		const status = await shelf.run(["daemon", "status"]);
		expect(status.exitCode).toBe(0);
		expect(status.stdout).toContain("Daemon is not running");
	});

	test("stop sends no signal when the recorded PID is another process", async () => {
		const other = spawnOtherProcess();
		await writeState(other, "a".repeat(32));

		const stop = await shelf.run(["daemon", "stop"]);
		expect(stop.exitCode).toBe(1);
		expect(stop.stderr).toContain("No daemon is currently running");
		await Bun.sleep(200);
		expect(isAlive(other)).toBe(true);
	});

	test("a real daemon whose token does not match the record is not the shelf daemon", async () => {
		const pid = await startDaemon();
		await writeState(pid, "b".repeat(32));

		const status = await shelf.run(["daemon", "status"]);
		expect(status.stdout).toContain("Daemon is not running");
		const stop = await shelf.run(["daemon", "stop"]);
		expect(stop.exitCode).toBe(1);
		expect(isAlive(pid)).toBe(true);
	}, 20_000);
});

describe("daemon stop", () => {
	test("stops the daemon, which removes its state file", async () => {
		const pid = await startDaemon();
		const stop = await shelf.run(["daemon", "stop"]);
		expect(stop.exitCode).toBe(0);
		expect(stop.stdout).toContain("Daemon stopped");
		expect(isAlive(pid)).toBe(false);
		expect(await Bun.file(statePath()).exists()).toBe(false);
	}, 20_000);

	test("on SIGTERM the daemon removes its own state file and exits", async () => {
		const pid = await startDaemon();
		process.kill(pid, "SIGTERM");
		expect(await waitFor(() => !isAlive(pid))).toBe(true);
		expect(await Bun.file(statePath()).exists()).toBe(false);
		expect(await Bun.file(logPath()).text()).toContain("Daemon stopped");
	}, 20_000);
});

describe("daemon log", () => {
	test("start appends to the existing log", async () => {
		await Bun.write(logPath(), "earlier line\n");
		await startDaemon();
		expect(
			await waitFor(async () => (await Bun.file(logPath()).text()).includes("Daemon started")),
		).toBe(true);
		expect(await Bun.file(logPath()).text()).toStartWith("earlier line\n");
	}, 20_000);

	test("start rotates a log over 5 MB to daemon.log.1", async () => {
		const big = "x".repeat(5_242_881);
		await Bun.write(logPath(), big);
		await startDaemon();
		expect(await Bun.file(`${logPath()}.1`).text()).toBe(big);
		expect(
			await waitFor(async () => (await Bun.file(logPath()).text()).includes("Daemon started")),
		).toBe(true);
		expect(Bun.file(logPath()).size).toBeLessThan(5_242_881);
	}, 20_000);
});
