import * as Schema from "effect/Schema";

export class ResolveError extends Schema.TaggedError<ResolveError>()("ResolveError", {
  input: Schema.String,
  message: Schema.String,
}) {}
