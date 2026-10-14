import * as Schema from "effect/Schema";

export class ShelffileNotFoundError extends Schema.TaggedError<ShelffileNotFoundError>()(
	"ShelffileNotFoundError",
	{ path: Schema.String },
) {}

export class ShelffileParseError extends Schema.TaggedError<ShelffileParseError>()(
	"ShelffileParseError",
	{ message: Schema.String },
) {}
