import * as Schema from "effect/Schema";

export class RepoNotFoundError extends Schema.TaggedError<RepoNotFoundError>()(
	"RepoNotFoundError",
	{ alias: Schema.String },
) {}

export class RepoAlreadyExistsError extends Schema.TaggedError<RepoAlreadyExistsError>()(
	"RepoAlreadyExistsError",
	{ alias: Schema.String },
) {}

export class AutoPinResolutionError extends Schema.TaggedError<AutoPinResolutionError>()(
	"AutoPinResolutionError",
	{ message: Schema.String },
) {}
