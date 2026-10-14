import * as Schema from "effect/Schema";

export class DetectError extends Schema.TaggedError<DetectError>()("DetectError", {
  message: Schema.String,
}) {}
