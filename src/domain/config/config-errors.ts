import * as Schema from "effect/Schema";

export class ConfigNotFoundError extends Schema.TaggedError<ConfigNotFoundError>()(
	"ConfigNotFoundError",
	{ path: Schema.String },
) {}

export class ConfigParseError extends Schema.TaggedError<ConfigParseError>()("ConfigParseError", {
	message: Schema.String,
}) {}
