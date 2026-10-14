import * as Schema from "effect/Schema";

/** A sync of every reference repo (`shelf update`) finished, but some repos failed. */
export class SyncFailedError extends Schema.TaggedError<SyncFailedError>()("SyncFailedError", {
	failed: Schema.Number,
	total: Schema.Number,
}) {}
