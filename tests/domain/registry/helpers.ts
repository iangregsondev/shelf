import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ShelfRegistry } from "../../../src/domain/registry/registry-schema";
import { defaultRegistry } from "../../../src/domain/registry/registry-schema";
import type { RegistryParseError } from "../../../src/domain/registry/registry-errors";
import { RegistryService, type ReferenceScan } from "../../../src/domain/registry/registry-service";

export type RegistryOverrides = {
	readonly load?: () => Effect.Effect<typeof ShelfRegistry.Type, RegistryParseError>;
	readonly update?: (
		fn: (current: ShelfRegistry) => ShelfRegistry,
	) => Effect.Effect<ShelfRegistry, RegistryParseError>;
	readonly registerProject?: (dir: string) => Effect.Effect<void, RegistryParseError>;
	readonly unregisterProject?: (dir: string) => Effect.Effect<void, RegistryParseError>;
	readonly addManual?: (alias: string) => Effect.Effect<void, RegistryParseError>;
	readonly removeManual?: (alias: string) => Effect.Effect<void, RegistryParseError>;
	readonly scanReferences?: () => Effect.Effect<ReferenceScan, RegistryParseError>;
	readonly dropProjects?: (dirs: ReadonlyArray<string>) => Effect.Effect<void, RegistryParseError>;
};

const defaultRegistryImpl = {
	load: (): Effect.Effect<typeof ShelfRegistry.Type, RegistryParseError> =>
		Effect.succeed(defaultRegistry),
	update: (
		fn: (current: ShelfRegistry) => ShelfRegistry,
	): Effect.Effect<ShelfRegistry, RegistryParseError> => Effect.succeed(fn(defaultRegistry)),
	registerProject: (): Effect.Effect<void, RegistryParseError> => Effect.void,
	unregisterProject: (): Effect.Effect<void, RegistryParseError> => Effect.void,
	addManual: (): Effect.Effect<void, RegistryParseError> => Effect.void,
	removeManual: (): Effect.Effect<void, RegistryParseError> => Effect.void,
	renameManual: (): Effect.Effect<void, RegistryParseError> => Effect.void,
	scanReferences: (): Effect.Effect<ReferenceScan, RegistryParseError> =>
		Effect.succeed({
			aliases: new Set<string>(),
			anyMightBeReferenced: false,
			staleProjects: [],
			warnings: [],
		}),
	dropProjects: (): Effect.Effect<void, RegistryParseError> => Effect.void,
};

export const createMockRegistryLayer = (
	overrides: RegistryOverrides = {},
): Layer.Layer<RegistryService> => {
	const impl = { ...defaultRegistryImpl, ...overrides };
	return Layer.succeed(RegistryService, RegistryService.of(impl));
};
