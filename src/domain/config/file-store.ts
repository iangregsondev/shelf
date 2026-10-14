// Storage boundary for reading files that may not exist yet (state files,
// logs, project manifests), through Effect's FileSystem.

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { FileSystem } from "effect/FileSystem";
import { StoredFileReadError } from "./config-errors";

/** The text of the file at `path`, or None when nothing is there. */
export const readFileIfExists = (
  fs: FileSystem,
  path: string,
): Effect.Effect<Option.Option<string>, StoredFileReadError> =>
  Effect.gen(function* () {
    const exists = yield* fs
      .exists(path)
      .pipe(Effect.mapError(() => new StoredFileReadError({ path, stage: "check" })));
    if (!exists) return Option.none();
    const text = yield* fs
      .readFileString(path)
      .pipe(Effect.mapError(() => new StoredFileReadError({ path, stage: "read" })));
    return Option.some(text);
  });

/** The parsed JSON of the file at `path`, or None when nothing is there. */
export const readJsonIfExists = (
  fs: FileSystem,
  path: string,
): Effect.Effect<Option.Option<unknown>, StoredFileReadError> =>
  readFileIfExists(fs, path).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none()),
        onSome: (text) =>
          Effect.try({
            try: () => Option.some<unknown>(JSON.parse(text)),
            catch: () => new StoredFileReadError({ path, stage: "parse" }),
          }),
      }),
    ),
  );
