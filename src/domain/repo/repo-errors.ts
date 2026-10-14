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

export class PinResolutionError extends Schema.TaggedError<PinResolutionError>()(
	"PinResolutionError",
	{ message: Schema.String },
) {}

/** A reference repo's folder could not be created. */
export class RepoFolderError extends Schema.TaggedError<RepoFolderError>()("RepoFolderError", {
	path: Schema.String,
	message: Schema.String,
}) {}

export class AliasRenameError extends Schema.TaggedError<AliasRenameError>()("AliasRenameError", {
	from: Schema.String,
	to: Schema.String,
	message: Schema.String,
}) {}
