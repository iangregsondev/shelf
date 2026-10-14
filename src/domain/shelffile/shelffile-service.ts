import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import { FileSystem } from "effect/FileSystem";
import { dirname, join } from "node:path";
import { ShelffileNotFoundError, ShelffileParseError } from "./shelffile-errors";
import { parseShelffile, possibleShelffileAliases, serializeShelffile } from "./shelffile-utils";
import type { Shelffile } from "./shelffile-schema";

const SHELFFILE_NAME = "shelffile";

export class ShelffileService extends Context.Service<ShelffileService>()(
  "shelf/domain/shelffile/ShelffileService",
  {
    make: Effect.gen(function* () {
      const fs = yield* FileSystem;
      return {
        read: Effect.fn("ShelffileService.read")(function* (dir: string) {
          const filePath = join(dir, SHELFFILE_NAME);
          const fileExists = yield* fs
            .exists(filePath)
            .pipe(Effect.mapError(() => new ShelffileNotFoundError({ path: filePath })));
          if (!fileExists) {
            return yield* new ShelffileNotFoundError({ path: filePath });
          }
          const content = yield* fs
            .readFileString(filePath)
            .pipe(
              Effect.mapError(
                () => new ShelffileParseError({ message: `Failed to read ${filePath}` }),
              ),
            );
          return yield* Effect.try({
            try: () => parseShelffile(content),
            catch: (e) => {
              /* v8 ignore else -- parseShelffile only throws ShelffileParseError; the fallback guards an unexpected throw */
              if (e instanceof ShelffileParseError) return e;
              /* v8 ignore next -- unreachable, see above */
              return new ShelffileParseError({ message: `Failed to parse ${filePath}` });
            },
          });
        }),

        /**
         * Every alias the shelffile in `dir` might reference, read leniently
         * (see `possibleShelffileAliases`), for a shelffile that won't parse.
         */
        possibleAliases: Effect.fn("ShelffileService.possibleAliases")(function* (dir: string) {
          const filePath = join(dir, SHELFFILE_NAME);
          const content = yield* fs
            .readFileString(filePath)
            .pipe(
              Effect.mapError(
                () => new ShelffileParseError({ message: `Failed to read ${filePath}` }),
              ),
            );
          return possibleShelffileAliases(content);
        }),

        write: Effect.fn("ShelffileService.write")(function* (dir: string, shelffile: Shelffile) {
          const filePath = join(dir, SHELFFILE_NAME);
          const content = serializeShelffile(shelffile);
          // Create the folder if it is missing, as writes always have.
          yield* fs.makeDirectory(dirname(filePath), { recursive: true }).pipe(
            Effect.andThen(fs.writeFileString(filePath, content)),
            Effect.mapError(
              () => new ShelffileParseError({ message: `Failed to write ${filePath}` }),
            ),
          );
        }),
      };
    }),
  },
) {
  static layer = Layer.effect(this, this.make);
}
