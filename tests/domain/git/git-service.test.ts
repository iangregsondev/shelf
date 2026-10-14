import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlatformLayer } from "../../helpers/platform";
import { RepoPin } from "../../../src/domain/config/config-schema";
import { GitService } from "../../../src/domain/git/git-service";
import { createBareRepo, createTempRepo } from "../../helpers/temp-repo";
import { readText, writeText } from "../../helpers/files";
import { git, run } from "../../helpers/process";
import { existsSync } from "node:fs";

/** Runs `use` against the real GitService. */
const withGit = <A, E>(use: (service: GitService["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    return yield* use(yield* GitService);
  }).pipe(Effect.provide(GitService.layer), Effect.provide(PlatformLayer));

const runGit = <A, E>(use: (service: GitService["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(withGit(use));

const failGit = <A, E>(use: (service: GitService["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(withGit(use).pipe(Effect.flip));

describe("GitService running git", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "shelf-git-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("clone", () => {
    test("clones a repo to target dir", async () => {
      const source = await createBareRepo({ "hello.txt": "world" });
      const targetDir = join(tempDir, "cloned");
      await Effect.runPromise(
        withGit((service) =>
          service.clone(source.dir, targetDir, Option.none(), Option.none(), Option.none()),
        ),
      );
      const filePath = join(targetDir, "hello.txt");
      expect(existsSync(filePath)).toBe(true);
      expect(await readText(filePath)).toBe("world");
      await source.cleanup();
    });

    test("fails with a GitOperationError on a URL with no repo", async () => {
      const targetDir = join(tempDir, "bad-clone");
      const result = await Effect.runPromise(
        withGit((service) =>
          service.clone(
            `file://${join(tempDir, "nonexistent.git")}`,
            targetDir,
            Option.none(),
            Option.none(),
            Option.none(),
          ),
        ).pipe(Effect.flip),
      );
      expect(result._tag).toBe("GitOperationError");
      expect(result.message.length).toBeGreaterThan(0);
    });
  });

  describe("fetch", () => {
    test("fetches successfully from a cloned repo", async () => {
      const source = await createBareRepo();
      const targetDir = join(tempDir, "fetch-test");
      await git(["clone", source.dir, targetDir]);
      await Effect.runPromise(
        withGit((service) =>
          service.fetch(targetDir, "+refs/heads/*:refs/remotes/origin/*", Option.none()),
        ),
      );
      await source.cleanup();
    });

    test("fails for non-repo directory", async () => {
      const result = await Effect.runPromiseExit(
        withGit((service) =>
          service.fetch(tempDir, "+refs/heads/*:refs/remotes/origin/*", Option.none()),
        ),
      );
      expect(result._tag).toBe("Failure");
    });
  });

  describe("checkout", () => {
    test("checks out a commit by hash", async () => {
      const source = await createTempRepo({ "file.txt": "initial content" });
      await run(["git", "checkout", "-b", "feature-branch"], { cwd: source.dir });
      await writeText(join(source.dir, "file.txt"), "feature content");
      await run(["git", "add", "."], { cwd: source.dir });
      await run(["git", "commit", "-m", "feature commit"], { cwd: source.dir });

      const initialHash = (
        await run(["git", "rev-list", "--max-parents=0", "HEAD"], { cwd: source.dir })
      ).stdout.trim();

      await Effect.runPromise(withGit((service) => service.checkout(source.dir, initialHash)));
      const filePath = join(source.dir, "file.txt");
      expect(await readText(filePath)).toBe("initial content");
      await source.cleanup();
    });

    test("checks out a named branch", async () => {
      const source = await createTempRepo({ "file.txt": "v1" });
      await run(["git", "checkout", "-b", "release-v2"], { cwd: source.dir });
      await writeText(join(source.dir, "file.txt"), "v2");
      await run(["git", "add", "."], { cwd: source.dir });
      await run(["git", "commit", "-m", "v2"], { cwd: source.dir });
      await run(["git", "checkout", "-"], { cwd: source.dir });

      await Effect.runPromise(withGit((service) => service.checkout(source.dir, "release-v2")));
      const filePath = join(source.dir, "file.txt");
      expect(await readText(filePath)).toBe("v2");
      await source.cleanup();
    });
  });
});

describe("GitService", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "shelf-gitsvc-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("clone with no pin", async () => {
    const source = await createBareRepo({ "test.txt": "hello" });
    const targetDir = join(tempDir, "svc-clone");
    await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* GitService;
        yield* git.clone(source.dir, targetDir, Option.none(), Option.none(), Option.none());
      }).pipe(Effect.provide(GitService.layer), Effect.provide(PlatformLayer)),
    );
    expect(existsSync(join(targetDir, "test.txt"))).toBe(true);
    await source.cleanup();
  });

  test("clone with branch pin", async () => {
    const source = await createBareRepo({ "test.txt": "hello" });
    const defaultBranch = (
      await run(["git", "symbolic-ref", "HEAD", "--short"], { cwd: source.dir })
    ).stdout.trim();
    const targetDir = join(tempDir, "svc-branch-clone");
    await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* GitService;
        yield* git.clone(
          source.dir,
          targetDir,
          Option.some(new RepoPin({ type: "branch", value: defaultBranch })),
          Option.none(),
          Option.none(),
        );
      }).pipe(Effect.provide(GitService.layer), Effect.provide(PlatformLayer)),
    );
    expect(existsSync(join(targetDir, "test.txt"))).toBe(true);
    await source.cleanup();
  });

  test("clone with tag pin", async () => {
    const source = await createTempRepo({ "test.txt": "hello" });
    await run(["git", "tag", "v1.0.0"], { cwd: source.dir });
    const bareSource = await createBareRepo({ "test.txt": "hello" });
    // Add tag to bare repo manually
    await run(["git", "tag", "v1.0.0"], { cwd: bareSource.dir });
    const targetDir = join(tempDir, "svc-tag-clone");
    await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* GitService;
        yield* git.clone(
          bareSource.dir,
          targetDir,
          Option.some(new RepoPin({ type: "tag", value: "v1.0.0" })),
          Option.none(),
          Option.none(),
        );
      }).pipe(Effect.provide(GitService.layer), Effect.provide(PlatformLayer)),
    );
    expect(existsSync(join(targetDir, "test.txt"))).toBe(true);
    await source.cleanup();
    await bareSource.cleanup();
  });

  test("shallow clone creates .git/shallow", async () => {
    // Need multiple commits and file:// protocol (--depth is ignored for local paths)
    const sourceRepo = await createTempRepo({ "test.txt": "hello" });
    await writeText(join(sourceRepo.dir, "test.txt"), "updated");
    await run(["git", "add", "."], { cwd: sourceRepo.dir });
    await run(["git", "commit", "-m", "second"], { cwd: sourceRepo.dir });
    const bareDir = await mkdtemp(join(tmpdir(), "shelf-bare-shallow-"));
    await rm(bareDir, { recursive: true, force: true });
    await run(["git", "clone", "--bare", sourceRepo.dir, bareDir]);
    const targetDir = join(tempDir, "svc-shallow-clone");
    await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* GitService;
        yield* git.clone(
          `file://${bareDir}`,
          targetDir,
          Option.none(),
          Option.some(1),
          Option.none(),
        );
      }).pipe(Effect.provide(GitService.layer), Effect.provide(PlatformLayer)),
    );
    expect(existsSync(join(targetDir, "test.txt"))).toBe(true);
    expect(existsSync(join(targetDir, ".git", "shallow"))).toBe(true);
    await sourceRepo.cleanup();
    await rm(bareDir, { recursive: true, force: true });
  });

  test("sparse checkout only checks out specified paths", async () => {
    const source = await createBareRepo({
      "src/index.ts": "export {}",
      "docs/readme.md": "# Docs",
      "packages/core/index.ts": "core",
    });
    const targetDir = join(tempDir, "svc-sparse-clone");
    await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* GitService;
        yield* git.clone(source.dir, targetDir, Option.none(), Option.none(), Option.some(["src"]));
      }).pipe(Effect.provide(GitService.layer), Effect.provide(PlatformLayer)),
    );
    expect(existsSync(join(targetDir, "src", "index.ts"))).toBe(true);
    expect(existsSync(join(targetDir, "docs", "readme.md"))).toBe(false);
    await source.cleanup();
  });

  test("fetch on a cloned repo", async () => {
    const source = await createBareRepo();
    const targetDir = join(tempDir, "svc-fetch");
    await git(["clone", source.dir, targetDir]);
    await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* GitService;
        yield* git.fetch(targetDir, "+refs/heads/*:refs/remotes/origin/*", Option.none());
      }).pipe(Effect.provide(GitService.layer), Effect.provide(PlatformLayer)),
    );
    await source.cleanup();
  });

  test("shallow fetch preserves shallow clone", async () => {
    // Use file:// protocol so --depth works with local repos
    const sourceRepo = await createTempRepo({ "test.txt": "hello" });
    await writeText(join(sourceRepo.dir, "test.txt"), "updated");
    await run(["git", "add", "."], { cwd: sourceRepo.dir });
    await run(["git", "commit", "-m", "second"], { cwd: sourceRepo.dir });
    const bareDir = await mkdtemp(join(tmpdir(), "shelf-bare-sfetch-"));
    await rm(bareDir, { recursive: true, force: true });
    await run(["git", "clone", "--bare", sourceRepo.dir, bareDir]);
    const targetDir = join(tempDir, "svc-shallow-fetch");
    await git(["clone", "--depth", "1", `file://${bareDir}`, targetDir]);
    await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* GitService;
        yield* git.fetch(targetDir, "+refs/heads/*:refs/remotes/origin/*", Option.some(1));
      }).pipe(Effect.provide(GitService.layer), Effect.provide(PlatformLayer)),
    );
    expect(existsSync(join(targetDir, ".git", "shallow"))).toBe(true);
    await sourceRepo.cleanup();
    await rm(bareDir, { recursive: true, force: true });
  });

  test("getDefaultBranch returns correct branch", async () => {
    const source = await createBareRepo();
    const targetDir = join(tempDir, "svc-default-branch");
    await git(["clone", source.dir, targetDir]);
    const branch = await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* GitService;
        return yield* git.getDefaultBranch(targetDir);
      }).pipe(Effect.provide(GitService.layer), Effect.provide(PlatformLayer)),
    );
    expect(typeof branch).toBe("string");
    expect(branch.length).toBeGreaterThan(0);
    await source.cleanup();
  });
});

describe("GitService against a local origin", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "shelf-git-ops-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  /**
   * A bare origin in the temp dir with three commits on `main` (file.txt
   * holding "one", "two", "three") and a tag `v1` on the first. Returns its
   * `file://` URL, so `--depth` is honoured, and the commit hashes, oldest first.
   */
  const createOrigin = async (): Promise<{ url: string; dir: string; commits: string[] }> => {
    const work = join(tempDir, "work");
    await git(["init", "--initial-branch=main", work]);
    await git(["config", "user.email", "test@test.com"], work);
    await git(["config", "user.name", "Test"], work);
    const commits: string[] = [];
    for (const content of ["one", "two", "three"]) {
      await writeText(join(work, "file.txt"), content);
      await git(["add", "."], work);
      await git(["commit", "-m", content], work);
      commits.push(await git(["rev-parse", "HEAD"], work));
    }
    await git(["tag", "v1", commits[0]!], work);
    const dir = join(tempDir, "origin.git");
    await git(["clone", "--bare", work, dir]);
    return { url: `file://${dir}`, dir, commits };
  };

  const isShallow = async (repoDir: string) =>
    (await git(["rev-parse", "--is-shallow-repository"], repoDir)) === "true";

  const hasLocalCommit = async (repoDir: string, hash: string) => {
    try {
      await git(["cat-file", "-e", `${hash}^{commit}`], repoDir);
      return true;
    } catch {
      return false;
    }
  };

  describe("GitService failures", () => {
    test("a git command that fails reports its stderr and the command line", async () => {
      const { url } = await createOrigin();
      const clone = join(tempDir, "clone");
      await git(["clone", url, clone]);
      const error = await failGit((service) => service.checkout(clone, "no-such-ref"));
      expect(error._tag).toBe("GitOperationError");
      expect(error.command).toBe("git checkout --detach no-such-ref --");
      expect(error.message).toContain("no-such-ref");
    });

    test("a git command that fails without stderr names its exit code", async () => {
      // A stand-in `git` first on PATH that exits 5 and prints nothing.
      const shimDir = join(tempDir, "bin");
      await writeText(join(shimDir, "git"), "#!/bin/sh\nexit 5\n");
      await chmod(join(shimDir, "git"), 0o755);
      const previousPath = process.env["PATH"];
      process.env["PATH"] = `${shimDir}:${previousPath ?? ""}`;
      try {
        const error = await failGit((service) =>
          service.fetch(tempDir, "+refs/heads/*:refs/remotes/origin/*", Option.none()),
        );
        expect(error._tag).toBe("GitOperationError");
        expect(error.message).toBe("git fetch failed with exit code 5");
      } finally {
        process.env["PATH"] = previousPath;
      }
    });

    test("git that cannot start fails with a GitOperationError", async () => {
      const missing = join(tempDir, "missing");
      const error = await failGit((service) => service.checkout(missing, "main"));
      expect(error._tag).toBe("GitOperationError");
      expect(error.command).toBe("git checkout --detach main --");
      expect(error.message.length).toBeGreaterThan(0);
    });

    test("clone from a path that is not a repo fails", async () => {
      const error = await failGit((service) =>
        service.clone(
          join(tempDir, "nowhere"),
          join(tempDir, "clone"),
          Option.none(),
          Option.none(),
          Option.none(),
        ),
      );
      expect(error._tag).toBe("GitOperationError");
      expect(error.command.startsWith("git clone")).toBe(true);
    });
  });

  describe("GitService.clone with a commit pin", () => {
    test("clones full history and checks out the pinned commit detached", async () => {
      const { url, commits } = await createOrigin();
      const target = join(tempDir, "clone");
      await runGit((service) =>
        service.clone(
          url,
          target,
          Option.some(new RepoPin({ type: "commit", value: commits[0]! })),
          Option.none(),
          Option.none(),
        ),
      );
      expect(await readText(join(target, "file.txt"))).toBe("one");
      expect(await git(["rev-parse", "HEAD"], target)).toBe(commits[0]);
      expect(await isShallow(target)).toBe(false);
      // Not --single-branch: the tag ref from origin came along too.
      expect(await git(["tag", "--list"], target)).toBe("v1");
    });

    test("with a depth that misses a full-hash pin, fetches that commit", async () => {
      const { url, commits } = await createOrigin();
      const target = join(tempDir, "clone");
      await runGit((service) =>
        service.clone(
          url,
          target,
          Option.some(new RepoPin({ type: "commit", value: commits[0]! })),
          Option.some(1),
          Option.none(),
        ),
      );
      expect(await readText(join(target, "file.txt"))).toBe("one");
      expect(await git(["rev-parse", "HEAD"], target)).toBe(commits[0]);
    });

    test("with a depth that misses a short-hash pin, fetches the full history", async () => {
      const { url, commits } = await createOrigin();
      const target = join(tempDir, "clone");
      await runGit((service) =>
        service.clone(
          url,
          target,
          Option.some(new RepoPin({ type: "commit", value: commits[0]!.slice(0, 7) })),
          Option.some(1),
          Option.none(),
        ),
      );
      expect(await git(["rev-parse", "HEAD"], target)).toBe(commits[0]);
      expect(await isShallow(target)).toBe(false);
    });
  });

  describe("GitService.clone with a sparse checkout", () => {
    test("a sparse clone with a branch pin checks out only the listed paths of that branch", async () => {
      const { url } = await createOrigin();
      const target = join(tempDir, "clone");
      await runGit((service) =>
        service.clone(
          url,
          target,
          Option.some(new RepoPin({ type: "branch", value: "main" })),
          Option.none(),
          Option.some(["docs"]),
        ),
      );
      // Cone mode keeps top-level files; nothing under other directories exists.
      expect(await readText(join(target, "file.txt"))).toBe("three");
      expect(await git(["sparse-checkout", "list"], target)).toBe("docs");
    });
  });

  describe("GitService.hasCommit", () => {
    test("is true for a commit in the clone and false otherwise", async () => {
      const { url, commits } = await createOrigin();
      const clone = join(tempDir, "clone");
      await git(["clone", "--depth", "1", url, clone]);
      expect(await runGit((service) => service.hasCommit(clone, commits[2]!))).toBe(true);
      expect(await runGit((service) => service.hasCommit(clone, commits[0]!))).toBe(false);
      expect(await runGit((service) => service.hasCommit(clone, "not-a-rev"))).toBe(false);
    });
  });

  describe("GitService.fetchHistory", () => {
    test("unshallows a shallow clone", async () => {
      const { url, commits } = await createOrigin();
      const clone = join(tempDir, "clone");
      await git(["clone", "--depth", "1", url, clone]);
      await runGit((service) => service.fetchHistory(clone));
      expect(await isShallow(clone)).toBe(false);
      expect(await hasLocalCommit(clone, commits[0]!)).toBe(true);
    });

    test("fetches new branches into a full clone", async () => {
      const { url, dir, commits } = await createOrigin();
      const clone = join(tempDir, "clone");
      await git(["clone", url, clone]);
      await git(["branch", "later", commits[1]!], dir);
      await runGit((service) => service.fetchHistory(clone));
      expect(await git(["rev-parse", "refs/remotes/origin/later"], clone)).toBe(commits[1]);
      expect(await isShallow(clone)).toBe(false);
    });

    test("fails outside a git repo", async () => {
      const error = await failGit((service) => service.fetchHistory(tempDir));
      expect(error._tag).toBe("GitOperationError");
      expect(error.command).toBe("git rev-parse --is-shallow-repository");
    });
  });

  describe("GitService.ensureCommit", () => {
    test("does nothing when the commit is already local", async () => {
      const { url, commits } = await createOrigin();
      const clone = join(tempDir, "clone");
      await git(["clone", "--depth", "1", url, clone]);
      // With origin gone, any fetch would fail.
      await git(["remote", "remove", "origin"], clone);
      await runGit((service) => service.ensureCommit(clone, commits[2]!));
      expect(await isShallow(clone)).toBe(true);
    });

    test("fetches a missing full hash by itself, keeping the clone shallow", async () => {
      const { url, commits } = await createOrigin();
      const clone = join(tempDir, "clone");
      await git(["clone", "--depth", "1", url, clone]);
      await runGit((service) => service.ensureCommit(clone, commits[0]!));
      expect(await hasLocalCommit(clone, commits[0]!)).toBe(true);
      expect(await isShallow(clone)).toBe(true);
    });

    test("fetches the history for a missing short hash", async () => {
      const { url, commits } = await createOrigin();
      const clone = join(tempDir, "clone");
      await git(["clone", "--depth", "1", url, clone]);
      await runGit((service) => service.ensureCommit(clone, commits[0]!.slice(0, 8)));
      expect(await hasLocalCommit(clone, commits[0]!)).toBe(true);
      expect(await isShallow(clone)).toBe(false);
    });

    test("fails when origin does not have the commit", async () => {
      const { url } = await createOrigin();
      const clone = join(tempDir, "clone");
      await git(["clone", "--depth", "1", url, clone]);
      const error = await failGit((service) => service.ensureCommit(clone, "0".repeat(40)));
      expect(error._tag).toBe("GitOperationError");
      expect(error.command).toBe(`git fetch --no-tags -- origin ${"0".repeat(40)}`);
    });
  });

  describe("GitService.resolveCommit", () => {
    test("expands a short hash, in any case, to the full hash", async () => {
      const { url, commits } = await createOrigin();
      const clone = join(tempDir, "clone");
      await git(["clone", url, clone]);
      const short = commits[1]!.slice(0, 7).toUpperCase();
      expect(await runGit((service) => service.resolveCommit(clone, short))).toBe(commits[1]);
      expect(await runGit((service) => service.resolveCommit(clone, commits[0]!))).toBe(commits[0]);
    });

    test("fails when no such commit is local", async () => {
      const { url } = await createOrigin();
      const clone = join(tempDir, "clone");
      await git(["clone", url, clone]);
      const error = await failGit((service) => service.resolveCommit(clone, "deadbeef"));
      expect(error._tag).toBe("GitOperationError");
      expect(error.command).toBe("git rev-parse --verify deadbeef^{commit}");
      expect(error.message).toBe('no single commit "deadbeef" in the repo');
    });

    test("fails when the name is a ref, not a hash", async () => {
      const { url } = await createOrigin();
      const clone = join(tempDir, "clone");
      await git(["clone", url, clone]);
      const error = await failGit((service) => service.resolveCommit(clone, "v1"));
      expect(error._tag).toBe("GitOperationError");
      expect(error.message).toBe('"v1" names a ref, not a commit');
    });
  });

  describe("GitService remote listings", () => {
    test("lsRemoteRefs lists every branch and tag of a remote", async () => {
      const { url, commits } = await createOrigin();
      const output = await runGit((service) => service.lsRemoteRefs(url));
      expect(output.split("\n")).toEqual([
        `${commits[2]}\trefs/heads/main`,
        `${commits[0]}\trefs/tags/v1`,
      ]);
    });

    test("lsRemoteTags lists the tags of a remote", async () => {
      const { url, commits } = await createOrigin();
      expect(await runGit((service) => service.lsRemoteTags(url))).toBe(
        `${commits[0]}\trefs/tags/v1`,
      );
    });

    test("both fail for a remote that is not a repo", async () => {
      const nowhere = join(tempDir, "nowhere");
      const refs = await failGit((service) => service.lsRemoteRefs(nowhere));
      expect(refs.command).toBe(`git ls-remote --refs -- ${nowhere}`);
      const tags = await failGit((service) => service.lsRemoteTags(nowhere));
      expect(tags.command).toBe(`git ls-remote --tags -- ${nowhere}`);
    });
  });

  describe("GitService.getDefaultBranch", () => {
    test("returns the branch origin's HEAD points at", async () => {
      const { url, dir } = await createOrigin();
      await git(["branch", "trunk", "main"], dir);
      await git(["symbolic-ref", "HEAD", "refs/heads/trunk"], dir);
      const clone = join(tempDir, "clone");
      await git(["clone", url, clone]);
      expect(await runGit((service) => service.getDefaultBranch(clone))).toBe("trunk");
    });

    test("fails when origin reports no default branch", async () => {
      const { url, dir } = await createOrigin();
      const clone = join(tempDir, "clone");
      await git(["clone", url, clone]);
      // HEAD on a branch that doesn't exist: ls-remote reports no symref for it.
      await git(["symbolic-ref", "HEAD", "refs/heads/gone"], dir);
      const error = await failGit((service) => service.getDefaultBranch(clone));
      expect(error._tag).toBe("GitOperationError");
      expect(error.message).toBe("the remote did not report a default branch");
    });

    test("fails outside a git repo", async () => {
      const error = await failGit((service) => service.getDefaultBranch(tempDir));
      expect(error._tag).toBe("GitOperationError");
      expect(error.command).toBe("git ls-remote --symref -- origin HEAD");
    });
  });

  describe("GitService.checkout", () => {
    test("leaves HEAD detached, even when the ref is a branch", async () => {
      const { url, commits } = await createOrigin();
      const clone = join(tempDir, "clone");
      await git(["clone", url, clone]);
      await git(["branch", "old", commits[0]!], clone);
      await runGit((service) => service.checkout(clone, "old"));
      expect(await readText(join(clone, "file.txt"))).toBe("one");
      expect(await readText(join(clone, ".git", "HEAD"))).toBe(`${commits[0]}\n`);
    });
  });
});
