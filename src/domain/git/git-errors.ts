import * as Schema from "effect/Schema";

export class GitOperationError extends Schema.TaggedError<GitOperationError>()(
  "GitOperationError",
  {
    command: Schema.String,
    message: Schema.String,
  },
) {}
