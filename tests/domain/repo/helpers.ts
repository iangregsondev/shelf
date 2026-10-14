import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import type { RepoEntry, RepoPin } from "../../../src/domain/config/config-schema";
import { RepoService } from "../../../src/domain/repo/repo-service";
import type { SyncAllResult } from "../../../src/domain/sync/sync-service";

type RepoShape = Parameters<typeof RepoService.of>[0];

export type RepoOverrides = Partial<RepoShape>;

// Canned successes; the casts keep this stub in step with the service's shape.
const defaultRepoImpl = {
  add: () => Effect.succeed("test-repo" as string),
  remove: () => Effect.succeed({ alias: "test-repo", orphan: false }),
  size: () => Effect.succeed(0),
  list: () => Effect.succeed([] as ReadonlyArray<RepoEntry>),
  sync: () => Effect.succeed<SyncAllResult>({ total: 0, failures: [] }),
  resolveAutoPin: () => Effect.succeed(undefined as unknown as Option.Option<RepoPin>),
  resolvePin: () => Effect.succeed(undefined as unknown as RepoPin),
  pin: () => Effect.succeed(undefined as unknown as RepoPin),
} as unknown as RepoShape;

export const createMockRepoLayer = (overrides: RepoOverrides = {}): Layer.Layer<RepoService> =>
  Layer.succeed(RepoService, RepoService.of({ ...defaultRepoImpl, ...overrides }));
