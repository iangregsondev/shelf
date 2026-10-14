import { describe, test, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { RepoPin } from "../../../src/domain/config/config-schema";
import { RepoEntry } from "../../../src/domain/config/config-schema";
import { SyncService } from "../../../src/domain/sync/sync-service";
import { createMockConfigLayer } from "../config/helpers";
import { createMockGitLayer } from "../git/helpers";

const makeTestRepo = (
  overrides: Partial<{
    alias: string;
    lastSyncedAt: Option.Option<string>;
    pin: Option.Option<RepoPin>;
  }> = {},
): RepoEntry =>
  new RepoEntry({
    url: "https://github.com/test/repo.git",
    alias: overrides.alias ?? "test-repo",
    addedAt: "2026-01-01T00:00:00Z",
    pin: overrides.pin ?? Option.none(),
    depth: Option.none(),
    sparse: Option.none(),
    lastSyncedAt: overrides.lastSyncedAt ?? Option.none(),
  });

const buildSyncLayer = (configOverrides = {}, gitOverrides = {}) => {
  const configLayer = createMockConfigLayer(configOverrides);
  const gitLayer = createMockGitLayer(gitOverrides);
  return SyncService.layer.pipe(Layer.provide(configLayer), Layer.provide(gitLayer));
};

describe("SyncService", () => {
  describe("syncAll", () => {
    test("syncs all repos in config", async () => {
      const fetchedRepos: string[] = [];
      const repos = [makeTestRepo({ alias: "repo-a" }), makeTestRepo({ alias: "repo-b" })];
      const layer = buildSyncLayer(
        { load: () => Effect.succeed({ version: 1 as const, syncIntervalMinutes: 60, repos }) },
        {
          fetch: (repoDir: string) => {
            fetchedRepos.push(repoDir);
            return Effect.void;
          },
        },
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const sync = yield* SyncService;
          yield* sync.syncAll();
        }).pipe(Effect.provide(layer)),
      );
      expect(fetchedRepos.length).toBe(2);
    });
  });
});
