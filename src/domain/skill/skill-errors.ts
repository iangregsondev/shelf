import * as Schema from "effect/Schema";

/** `--agent` named an agent shelf has no skill folder for. */
export class UnknownAgentError extends Schema.TaggedError<UnknownAgentError>()(
  "UnknownAgentError",
  { agent: Schema.String, known: Schema.Array(Schema.String) },
) {}
