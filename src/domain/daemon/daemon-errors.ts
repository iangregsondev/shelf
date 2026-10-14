import * as Schema from "effect/Schema";

export class DaemonAlreadyRunningError extends Schema.TaggedError<DaemonAlreadyRunningError>()(
	"DaemonAlreadyRunningError",
	{ pid: Schema.Number },
) {}

export class DaemonNotRunningError extends Schema.TaggedError<DaemonNotRunningError>()(
	"DaemonNotRunningError",
	{},
) {}

export class DaemonStartError extends Schema.TaggedError<DaemonStartError>()("DaemonStartError", {
	message: Schema.String,
}) {}
