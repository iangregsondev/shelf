import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const daemonStatePath = (configDir: string): string => join(configDir, "daemon.json");

export const daemonLogPath = (configDir: string): string => join(configDir, "daemon.log");

export const generateToken = (): string => randomBytes(16).toString("hex");

/** The token passed to the daemon process as `--token <token>`, if any. */
export const daemonTokenFromArgs = (argv: ReadonlyArray<string>): string | undefined => {
	const index = argv.indexOf("--token");
	if (index === -1) return undefined;
	return argv[index + 1];
};

/**
 * Whether a process command line is the shelf daemon with this token: it runs
 * the daemon entry point (`daemon.ts`) and carries `--token <token>`.
 */
export const isDaemonCommandLine = (commandLine: string, token: string): boolean => {
	const words = commandLine.trim().split(/\s+/);
	const runsEntryPoint = words.some((w) => w === "daemon.ts" || w.endsWith("/daemon.ts"));
	const tokenIndex = words.indexOf("--token");
	return runsEntryPoint && tokenIndex !== -1 && words[tokenIndex + 1] === token;
};
