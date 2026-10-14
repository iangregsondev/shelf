import * as Schema from "effect/Schema";

export class ShelffileNotFoundError extends Schema.TaggedError<ShelffileNotFoundError>()(
  "ShelffileNotFoundError",
  { path: Schema.String },
) {}

export class ShelffileParseError extends Schema.TaggedError<ShelffileParseError>()(
  "ShelffileParseError",
  { message: Schema.String },
) {}

/** `shelf install` ran every shelffile entry, but some could not be added. */
export class InstallFailedError extends Schema.TaggedError<InstallFailedError>()(
  "InstallFailedError",
  { failed: Schema.Number, total: Schema.Number },
) {}
