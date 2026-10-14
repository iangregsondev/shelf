import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import { GitOperationError } from "./git-errors";

const collectText = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  Stream.mkString(Stream.decodeText(stream));

export const runGit = (
  args: ReadonlyArray<string>,
  cwd?: string,
): Effect.Effect<string, GitOperationError, ChildProcessSpawner> => {
  const command = `git ${args.join(" ")}`;
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner;
    const proc = yield* spawner.spawn(
      ChildProcess.make("git", [...args], {
        cwd: cwd ?? process.cwd(),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: false,
      }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [collectText(proc.stdout), collectText(proc.stderr), proc.exitCode],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0) {
      return yield* new GitOperationError({
        command,
        message: stderr.trim() || `git ${args[0]} failed with exit code ${exitCode}`,
      });
    }
    return stdout.trim();
  }).pipe(
    Effect.scoped,
    Effect.mapError((error) =>
      error instanceof GitOperationError
        ? error
        : new GitOperationError({ command, message: error.message }),
    ),
  );
};

/**
 * Reads the default branch from `git ls-remote --symref <remote> HEAD`
 * output, whose first line is `ref: refs/heads/<branch>\tHEAD`.
 */
export const parseSymrefHead = (output: string): string | undefined => {
  for (const line of output.split("\n")) {
    const match = /^ref: refs\/heads\/(.+)\tHEAD$/.exec(line.trim());
    if (match) {
      return match[1];
    }
  }
  return undefined;
};

/**
 * One line that says why a git command failed, from its (often multi-line)
 * stderr: the first `fatal:` or `error:` line, which names the cause, else
 * the last non-empty line.
 */
export const gitErrorLine = (stderr: string): string => {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return (
    lines.find((line) => line.startsWith("fatal:") || line.startsWith("error:")) ??
    lines.at(-1) ??
    stderr.trim()
  );
};
