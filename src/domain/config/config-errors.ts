import * as Schema from "effect/Schema";

export class ConfigNotFoundError extends Schema.TaggedError<ConfigNotFoundError>()(
  "ConfigNotFoundError",
  { path: Schema.String },
) {}

export class ConfigParseError extends Schema.TaggedError<ConfigParseError>()("ConfigParseError", {
  message: Schema.String,
}) {}

/** Writing, locking or creating shelf state on disk failed. */
export class ConfigWriteError extends Schema.TaggedError<ConfigWriteError>()("ConfigWriteError", {
  message: Schema.String,
}) {}

export class InvalidConfigValueError extends Schema.TaggedError<InvalidConfigValueError>()(
  "InvalidConfigValueError",
  { message: Schema.String },
) {}

export class UnknownConfigKeyError extends Schema.TaggedError<UnknownConfigKeyError>()(
  "UnknownConfigKeyError",
  { key: Schema.String },
) {}

/** An alias that is not a single safe folder name. */
export class InvalidAliasError extends Schema.TaggedError<InvalidAliasError>()(
  "InvalidAliasError",
  { alias: Schema.String, message: Schema.String },
) {}

/**
 * Reading a stored file failed at one stage: checking whether it exists,
 * reading it, or parsing it as JSON. Services map it to their own errors.
 */
export class StoredFileReadError extends Schema.TaggedError<StoredFileReadError>()(
  "StoredFileReadError",
  { path: Schema.String, stage: Schema.Literals(["check", "read", "parse"]) },
) {}
