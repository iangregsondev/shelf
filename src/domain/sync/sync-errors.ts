import * as Schema from "effect/Schema";

/** `shelf update` synced every reference repo, but some of them failed. */
export class UpdateFailedError extends Schema.TaggedError<UpdateFailedError>()(
	"UpdateFailedError",
	{ failed: Schema.Number, total: Schema.Number },
) {}
