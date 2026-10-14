// A local `file://` git remote with branches, tags and older commits, for
// tests that pin, sync and resolve refs against a real remote.

import { join } from "node:path";
import { writeText } from "./files";
import { run } from "./process";

export const git = async (args: ReadonlyArray<string>, cwd: string): Promise<string> => {
  const { exitCode, stdout, stderr } = await run(["git", ...args], { cwd });
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
  return stdout.trim();
};

/**
 * A remote with history on `main` (three commits, tag `v1` on the second),
 * and a `feature` branch off the first commit.
 */
export interface Remote {
  readonly url: string;
  readonly commits: { readonly first: string; readonly second: string; readonly third: string };
  /** Commits `content` on `branch` (which must exist) and pushes it; returns the new commit. */
  readonly commit: (branch: string, content: string) => Promise<string>;
  /** Creates `branch` on the remote at commit `at`. */
  readonly branch: (branch: string, at: string) => Promise<void>;
}

/** Builds a remote inside `tempDir` (as `work/` and `remote.git/`). */
export const createRemote = async (tempDir: string): Promise<Remote> => {
  const work = join(tempDir, "work");
  const bare = join(tempDir, "remote.git");
  await git(["init", "-q", "-b", "main", work], tempDir);
  await git(["config", "user.email", "test@test.com"], work);
  await git(["config", "user.name", "Test"], work);
  const commitFile = async (content: string): Promise<string> => {
    await writeText(join(work, "file.txt"), content);
    await git(["add", "file.txt"], work);
    await git(["commit", "-q", "-m", content], work);
    return git(["rev-parse", "HEAD"], work);
  };
  const first = await commitFile("first");
  const second = await commitFile("second");
  await git(["tag", "-a", "v1", "-m", "v1"], work);
  const third = await commitFile("third");
  await git(["branch", "feature", first], work);
  await git(["clone", "-q", "--bare", work, bare], tempDir);
  await git(["remote", "add", "origin", bare], work);

  const commit = async (branch: string, content: string): Promise<string> => {
    await git(["checkout", "-q", branch], work);
    const sha = await commitFile(content);
    await git(["push", "-q", "origin", branch], work);
    return sha;
  };
  const branch = async (name: string, at: string): Promise<void> => {
    await git(["branch", name, at], bare);
  };
  return { url: `file://${bare}`, commits: { first, second, third }, commit, branch };
};
