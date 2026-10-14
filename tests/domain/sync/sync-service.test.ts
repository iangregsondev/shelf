import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoEntry, RepoPin, ShelfConfig } from "../../../src/domain/config/config-schema";
import { ConfigWriteError } from "../../../src/domain/config/config-errors";
import { GitOperationError } from "../../../src/domain/git/git-errors";
import { GitService } from "../../../src/domain/git/git-service";
import { SyncService } from "../../../src/domain/sync/sync-service";
import { createMockConfigLayer, type ConfigOverrides } from "../config/helpers";
import { createMockGitLayer, type GitOverrides } from "../git/helpers";
import { PlatformLayer } from "../../helpers/platform";
import { createRemote, type Remote } from "../../helpers/git-remote";
import { git } from "../../helpers/process";
import { writeText } from "../../helpers/files";

const makeTestRepo = (
  overrides: Partial<{
    alias: string;
    pin: Option.Option<RepoPin>;
    depth: Option.Option<number>;
    url: string;
  }> = {},
): RepoEntry =>
  new RepoEntry({
    url: overrides.url ?? "https://github.com/test/repo.git",
    alias: overrides.alias ?? "test-repo",
    addedAt: "2026-01-01T00:00:00Z",
    pin: overrides.pin ?? Option.none(),
    depth: overrides.depth ?? Option.none(),
    sparse: Option.none(),
    lastSyncedAt: Option.none(),
  });

const configOf = (repos: ReadonlyArray<RepoEntry>) =>
  new ShelfConfig({ version: 1, syncIntervalMinutes: 60, repos: [...repos] });

const buildSyncLayer = (configOverrides: ConfigOverrides = {}, gitOverrides: GitOverrides = {}) =>
  SyncService.layer.pipe(
    Layer.provide(createMockConfigLayer(configOverrides)),
    Layer.provide(createMockGitLayer(gitOverrides)),
  );

/** Git overrides that record every call the sync makes, in order. */
const recordingGit = (calls: Array<string>): GitOverrides => ({
  fetch: (repoDir, refspec, depth) =>
    Effect.sync(() => {
      calls.push(`fetch ${repoDir} ${refspec} depth=${Option.getOrElse(depth, () => "none")}`);
    }),
  checkout: (repoDir, ref) => Effect.sync(() => void calls.push(`checkout ${repoDir} ${ref}`)),
  ensureCommit: (repoDir, hash) =>
    Effect.sync(() => void calls.push(`ensureCommit ${repoDir} ${hash}`)),
  getDefaultBranch: (repoDir) =>
    Effect.sync(() => {
      calls.push(`getDefaultBranch ${repoDir}`);
      return "trunk";
    }),
});

const runSyncRepo = (repo: RepoEntry, layer: Layer.Layer<SyncService>) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const sync = yield* SyncService;
      yield* sync.syncRepo(repo);
    }).pipe(Effect.provide(layer)),
  );

/** The error `syncRepo` fails with; rejects if it succeeds. */
const syncRepoError = (repo: RepoEntry, layer: Layer.Layer<SyncService>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sync = yield* SyncService;
      yield* sync.syncRepo(repo);
    }).pipe(Effect.flip, Effect.provide(layer)),
  );

const runSyncAll = (layer: Layer.Layer<SyncService>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sync = yield* SyncService;
      return yield* sync.syncAll();
    }).pipe(Effect.provide(layer)),
  );

/** The folder the mock config layer gives reference repo `alias`. */
const dir = (alias: string) => `/tmp/shelf-test/repos/${alias}`;

describe("SyncService", () => {
  describe("syncRepo: what it fetches and checks out for each pin", () => {
    test("an unpinned repo fetches the remote's default branch with depth 1 and checks it out", async () => {
      const calls: Array<string> = [];
      const exit = await runSyncRepo(makeTestRepo(), buildSyncLayer({}, recordingGit(calls)));
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(calls).toEqual([
        `getDefaultBranch ${dir("test-repo")}`,
        `fetch ${dir("test-repo")} +refs/heads/trunk:refs/remotes/origin/trunk depth=1`,
        `checkout ${dir("test-repo")} refs/remotes/origin/trunk`,
      ]);
    });

    test("the repo's own depth replaces the default depth of 1", async () => {
      const calls: Array<string> = [];
      await runSyncRepo(
        makeTestRepo({ depth: Option.some(25) }),
        buildSyncLayer({}, recordingGit(calls)),
      );
      expect(calls[1]).toBe(
        `fetch ${dir("test-repo")} +refs/heads/trunk:refs/remotes/origin/trunk depth=25`,
      );
    });

    test("a branch pin fetches and checks out that branch, not the default", async () => {
      const calls: Array<string> = [];
      const repo = makeTestRepo({
        pin: Option.some(new RepoPin({ type: "branch", value: "release/2" })),
      });
      await runSyncRepo(repo, buildSyncLayer({}, recordingGit(calls)));
      expect(calls).toEqual([
        `fetch ${dir("test-repo")} +refs/heads/release/2:refs/remotes/origin/release/2 depth=1`,
        `checkout ${dir("test-repo")} refs/remotes/origin/release/2`,
      ]);
    });

    test("a tag pin fetches the tag into refs/tags and checks it out", async () => {
      const calls: Array<string> = [];
      const repo = makeTestRepo({
        pin: Option.some(new RepoPin({ type: "tag", value: "v1.2.3" })),
        depth: Option.some(3),
      });
      await runSyncRepo(repo, buildSyncLayer({}, recordingGit(calls)));
      expect(calls).toEqual([
        `fetch ${dir("test-repo")} +refs/tags/v1.2.3:refs/tags/v1.2.3 depth=3`,
        `checkout ${dir("test-repo")} refs/tags/v1.2.3`,
      ]);
    });

    test("a commit pin makes sure the commit is local and checks it out, with no shallow fetch", async () => {
      const calls: Array<string> = [];
      const repo = makeTestRepo({
        pin: Option.some(new RepoPin({ type: "commit", value: "abc1234" })),
      });
      await runSyncRepo(repo, buildSyncLayer({}, recordingGit(calls)));
      expect(calls).toEqual([
        `ensureCommit ${dir("test-repo")} abc1234`,
        `checkout ${dir("test-repo")} abc1234`,
      ]);
    });
  });

  describe("syncRepo: recording the sync", () => {
    test("a successful sync saves lastSyncedAt on that repo only", async () => {
      const repo = makeTestRepo({ alias: "a" });
      const other = makeTestRepo({ alias: "b" });
      const saved: Array<ShelfConfig> = [];
      const before = Date.now();
      const exit = await runSyncRepo(
        repo,
        buildSyncLayer({
          load: () => Effect.succeed(configOf([repo, other])),
          save: (cfg) => Effect.sync(() => void saved.push(cfg)),
        }),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(saved).toHaveLength(1);
      const [a, b] = saved[0]!.repos;
      const syncedAt = Date.parse(Option.getOrThrow(a!.lastSyncedAt));
      expect(syncedAt).toBeGreaterThanOrEqual(before);
      expect(syncedAt).toBeLessThanOrEqual(Date.now());
      expect(b!.lastSyncedAt).toEqual(Option.none());
    });

    test("a repo removed from the config while it synced stays removed", async () => {
      const saved: Array<ShelfConfig> = [];
      const exit = await runSyncRepo(
        makeTestRepo({ alias: "gone" }),
        buildSyncLayer({
          load: () => Effect.succeed(configOf([])),
          save: (cfg) => Effect.sync(() => void saved.push(cfg)),
        }),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(saved).toEqual([]);
    });

    test("a failed fetch fails with the git error and records no sync", async () => {
      const repo = makeTestRepo();
      const saved: Array<ShelfConfig> = [];
      const fetchError = new GitOperationError({ command: "git fetch", message: "unreachable" });
      const error = await syncRepoError(
        repo,
        buildSyncLayer(
          {
            load: () => Effect.succeed(configOf([repo])),
            save: (cfg) => Effect.sync(() => void saved.push(cfg)),
          },
          { fetch: () => Effect.fail(fetchError) },
        ),
      );
      expect(error).toBe(fetchError);
      expect(saved).toEqual([]);
    });

    test("a config that can't be saved fails the sync with the write error", async () => {
      const repo = makeTestRepo();
      const writeError = new ConfigWriteError({ message: "disk full" });
      const error = await syncRepoError(
        repo,
        buildSyncLayer({
          load: () => Effect.succeed(configOf([repo])),
          save: () => Effect.fail(writeError),
        }),
      );
      expect(error).toBe(writeError);
    });
  });

  describe("syncAll", () => {
    test("syncs every repo and reports no failures when all succeed", async () => {
      const synced: Array<string> = [];
      const repos = [makeTestRepo({ alias: "repo-a" }), makeTestRepo({ alias: "repo-b" })];
      const result = await runSyncAll(
        buildSyncLayer(
          { load: () => Effect.succeed(configOf(repos)) },
          { checkout: (repoDir) => Effect.sync(() => void synced.push(repoDir)) },
        ),
      );
      expect(result).toEqual({ total: 2, failures: [] });
      expect(synced).toEqual([dir("repo-a"), dir("repo-b")]);
    });

    test("carries on past a failing repo and reports it by alias", async () => {
      const synced: Array<string> = [];
      const repos = ["a", "bad", "c"].map((alias) => makeTestRepo({ alias }));
      const fetchError = new GitOperationError({ command: "git fetch", message: "unreachable" });
      const result = await runSyncAll(
        buildSyncLayer(
          { load: () => Effect.succeed(configOf(repos)) },
          {
            fetch: (repoDir) => (repoDir === dir("bad") ? Effect.fail(fetchError) : Effect.void),
            checkout: (repoDir) => Effect.sync(() => void synced.push(repoDir)),
          },
        ),
      );
      expect(result).toEqual({ total: 3, failures: [{ alias: "bad", error: fetchError }] });
      expect(synced).toEqual([dir("a"), dir("c")]);
    });

    test("an empty shelf syncs nothing", async () => {
      const result = await runSyncAll(buildSyncLayer({ load: () => Effect.succeed(configOf([])) }));
      expect(result).toEqual({ total: 0, failures: [] });
    });
  });

  describe("syncAll against a real git remote", () => {
    let tempDir: string;
    let remote: Remote;
    let reposDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "shelf-sync-test-"));
      remote = await createRemote(tempDir);
      reposDir = join(tempDir, "repos");
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    const clone = async (alias: string): Promise<string> => {
      const target = join(reposDir, alias);
      await git(["clone", "-q", remote.url, target], tempDir);
      return target;
    };

    const realSyncAll = (aliases: ReadonlyArray<string>) =>
      runSyncAll(
        SyncService.layer.pipe(
          Layer.provide(
            createMockConfigLayer({
              load: () =>
                Effect.succeed(
                  configOf(aliases.map((alias) => makeTestRepo({ alias, url: remote.url }))),
                ),
              repoPath: (alias) => join(reposDir, alias),
            }),
          ),
          Layer.provide(GitService.layer),
          Layer.provide(PlatformLayer),
        ),
      );

    test("reports each repo: up to date and behind sync, missing and dirty folders fail", async () => {
      const behind = await clone("behind");
      const dirty = await clone("dirty");
      await writeText(join(dirty, "file.txt"), "local edit");
      const newest = await remote.commit("main", "fourth");
      const upToDate = await clone("up-to-date");

      const result = await realSyncAll(["up-to-date", "behind", "missing", "dirty"]);

      expect(result.total).toBe(4);
      expect(result.failures.map((f) => [f.alias, f.error._tag])).toEqual([
        ["missing", "GitOperationError"],
        ["dirty", "GitOperationError"],
      ]);
      expect(await git(["rev-parse", "HEAD"], upToDate)).toBe(newest);
      expect(await git(["rev-parse", "HEAD"], behind)).toBe(newest);
      expect(await git(["rev-parse", "HEAD"], dirty)).toBe(remote.commits.third);
    });
  });
});
