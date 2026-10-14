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
