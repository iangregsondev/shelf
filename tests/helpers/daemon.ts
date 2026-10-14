// Test cleanup for daemons: kill whatever daemon a shelf home's daemon.json
// names, plus any PIDs the test already knows about, and wait until they exit.

import { join } from "node:path";

const isAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const readStatePid = async (home: string): Promise<number | undefined> => {
	try {
		const raw = (await Bun.file(join(home, "daemon.json")).json()) as { pid?: unknown };
		return typeof raw.pid === "number" ? raw.pid : undefined;
	} catch {
		return undefined;
	}
};

/** SIGKILLs the daemon recorded in `home` and any `extraPids`, then waits up to 5s for them to exit. */
export const stopDaemonIn = async (
	home: string,
	extraPids: ReadonlyArray<number> = [],
): Promise<void> => {
	const statePid = await readStatePid(home);
	const pids = new Set([...extraPids, ...(statePid === undefined ? [] : [statePid])]);
	// Never kill the test runner itself (some tests record it as a "live" PID).
	pids.delete(process.pid);
	for (const pid of pids) {
		if (!isAlive(pid)) continue;
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already gone
		}
	}
	const deadline = Date.now() + 5_000;
	while ([...pids].some(isAlive) && Date.now() < deadline) {
		await Bun.sleep(50);
	}
};
