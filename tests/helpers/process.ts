// Runs a command to completion and collects its output, on node:child_process.

import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:os";

export interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

/** Runs `git <args>` in `cwd` and returns its trimmed stdout; rejects with its stderr if it fails. */
export const git = async (args: ReadonlyArray<string>, cwd?: string): Promise<string> => {
  const result = await run(["git", ...args], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
};

/** Spawns `argv`, waits for it to exit and returns its exit code and output. Rejects only if it cannot start. */
export const run = (argv: ReadonlyArray<string>, options: RunOptions = {}): Promise<RunResult> =>
  new Promise((resolve, reject) => {
    const [command, ...args] = argv;
    if (command === undefined) {
      reject(new Error("run: empty command"));
      return;
    }
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({
        // A signal-killed process reports 128 + signal number, like a shell.
        exitCode: code ?? 128 + (signal ? constants.signals[signal] : 0),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });

/** True when the tests run as root. Root ignores file permissions, so tests that chmod a path to make it fail skip then. */
export const runningAsRoot = process.getuid?.() === 0;

/** The PID of a process that has already exited. */
export const deadPid = (): number => spawnSync(process.execPath, ["-e", ""]).pid;

/** A fixed id for temp folder names (`tempName`) in tests. */
export const TEMP_ID = "0b7c5d3e-1f2a-4b6c-8d9e-0a1b2c3d4e5f";
