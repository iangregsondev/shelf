import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import type { RepoEntry, RepoPin } from "../../../src/domain/config/config-schema";
import type { ConfigParseError } from "../../../src/domain/config/config-errors";
import type { GitOperationError } from "../../../src/domain/git/git-errors";
import type {
	AutoPinResolutionError,
	PinResolutionError,
	RepoAlreadyExistsError,
	RepoNotFoundError,
} from "../../../src/domain/repo/repo-errors";
import { RepoService } from "../../../src/domain/repo/repo-service";
import type { SyncAllResult } from "../../../src/domain/sync/sync-service";

export type RepoOverrides = {
	readonly add?: (
		url: string,
		alias: Option.Option<string>,
		pin: Option.Option<RepoPin>,
		depth: Option.Option<number>,
		sparse: Option.Option<ReadonlyArray<string>>,
	) => Effect.Effect<string, ConfigParseError | GitOperationError | RepoAlreadyExistsError>;
	readonly remove?: (
		aliasOrUrl: string,
	) => Effect.Effect<string, ConfigParseError | RepoNotFoundError>;
	readonly list?: () => Effect.Effect<ReadonlyArray<RepoEntry>, ConfigParseError>;
	readonly update?: (
		alias: Option.Option<string>,
	) => Effect.Effect<SyncAllResult, ConfigParseError | GitOperationError | RepoNotFoundError>;
	readonly resolveAutoPin?: (
		url: string,
		packageName: string,
	) => Effect.Effect<Option.Option<RepoPin>, AutoPinResolutionError | GitOperationError>;
	readonly resolvePin?: (
		url: string,
		raw: string,
	) => Effect.Effect<RepoPin, GitOperationError | PinResolutionError>;
	readonly pin?: (alias: string, raw: string) => Effect.Effect<RepoPin, unknown>;
};

const defaultRepoImpl = {
	add: () => Effect.succeed("test-repo" as string),
	remove: () => Effect.succeed("test-repo" as string),
	list: () => Effect.succeed([] as ReadonlyArray<RepoEntry>),
	update: () => Effect.succeed<SyncAllResult>({ total: 0, failures: [] }),
	resolveAutoPin: () => Effect.succeed(undefined as unknown as Option.Option<RepoPin>),
	resolvePin: () => Effect.succeed(undefined as unknown as RepoPin),
	pin: () => Effect.succeed(undefined as unknown as RepoPin),
};

export const createMockRepoLayer = (overrides: RepoOverrides = {}): Layer.Layer<RepoService> => {
	const impl = { ...defaultRepoImpl, ...overrides };
	return Layer.succeed(RepoService, RepoService.of(impl));
};
