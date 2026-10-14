import * as Schema from "effect/Schema";

/** `--agent` named an agent shelf has no skill folder for. */
export class UnknownAgentError extends Schema.TaggedError<UnknownAgentError>()(
  "UnknownAgentError",
  { agent: Schema.String, known: Schema.Array(Schema.String) },
) {}

/** The skill file, or the folder it goes in, could not be written. */
export class SkillWriteError extends Schema.TaggedError<SkillWriteError>()("SkillWriteError", {
  path: Schema.String,
  message: Schema.String,
}) {}
