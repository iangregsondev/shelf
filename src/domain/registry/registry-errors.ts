import * as Schema from "effect/Schema";

export class RegistryParseError extends Schema.TaggedError<RegistryParseError>()(
	"RegistryParseError",
	{ message: Schema.String },
) {}
