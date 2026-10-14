import * as Schema from "effect/Schema";

export class RegistryParseError extends Schema.TaggedError<RegistryParseError>()(
  "RegistryParseError",
  { message: Schema.String },
) {}

/** Writing or locking the registry file failed. */
export class RegistryWriteError extends Schema.TaggedError<RegistryWriteError>()(
  "RegistryWriteError",
  { message: Schema.String },
) {}
