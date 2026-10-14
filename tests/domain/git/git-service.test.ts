import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlatformLayer, runGit } from "../../helpers/platform";
import { RepoPin } from "../../../src/domain/config/config-schema";
import { GitService } from "../../../src/domain/git/git-service";
import { createBareRepo, createTempRepo } from "../../helpers/temp-repo";
import { readText, writeText } from "../../helpers/files";
import { run } from "../../helpers/process";
import { existsSync } from "node:fs";

describe("runGit", () => {
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
      await Effect.runPromise(runGit(["clone", source.dir, targetDir]));
      const filePath = join(targetDir, "hello.txt");
      expect(existsSync(filePath)).toBe(true);
      expect(await readText(filePath)).toBe("world");
      await source.cleanup();
    });

    test("clones with branch pin", async () => {
      const bareSource = await createBareRepo({ "file.txt": "content" });
      const defaultBranch = (
        await run(["git", "symbolic-ref", "HEAD", "--short"], { cwd: bareSource.dir })
      ).stdout.trim();
      const targetDir = join(tempDir, "branch-clone");
      await Effect.runPromise(
        runGit(["clone", "--branch", defaultBranch, bareSource.dir, targetDir]),
      );
      const filePath = join(targetDir, "file.txt");
      expect(existsSync(filePath)).toBe(true);
      await bareSource.cleanup();
    });

    test("fails on invalid URL", async () => {
      const targetDir = join(tempDir, "bad-clone");
      const result = await Effect.runPromiseExit(
        runGit(["clone", "https://invalid.example.com/nonexistent.git", targetDir]),
      );
      expect(result._tag).toBe("Failure");
    });
  });

  describe("fetch", () => {
    test("fetches successfully from a cloned repo", async () => {
      const source = await createBareRepo();
      const targetDir = join(tempDir, "fetch-test");
      await Effect.runPromise(runGit(["clone", source.dir, targetDir]));
      await Effect.runPromise(runGit(["fetch", "--all", "--prune"], targetDir));
      await source.cleanup();
    });

    test("fails for non-repo directory", async () => {
      const result = await Effect.runPromiseExit(runGit(["fetch", "--all"], tempDir));
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

      await Effect.runPromise(runGit(["checkout", initialHash], source.dir));
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

      await Effect.runPromise(runGit(["checkout", "release-v2"], source.dir));
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
    await Effect.runPromise(runGit(["clone", source.dir, targetDir]));
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
    await Effect.runPromise(runGit(["clone", "--depth", "1", `file://${bareDir}`, targetDir]));
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
    await Effect.runPromise(runGit(["clone", source.dir, targetDir]));
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
