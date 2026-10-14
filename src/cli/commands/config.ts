import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import * as Option from "effect/Option";
import { Argument, Command } from "effect/cli";
import { ConfigService } from "../../domain/config/config-service";
import { ShelfConfig, encodeConfig } from "../../domain/config/config-schema";
import { InvalidConfigValueError, UnknownConfigKeyError } from "../../domain/config/config-errors";
import { parseSyncInterval } from "../../domain/config/config-utils";

const key = Argument.String("key").pipe(Argument.optional);
const value = Argument.String("value").pipe(Argument.optional);

export const configCommand = Command.make("config", { key, value }, (args) =>
  Effect.gen(function* () {
    const configService = yield* ConfigService;
    const cfg = yield* configService.load();

    if (Option.isNone(args.key)) {
      // Encode first: decoded optional fields are Options, which print as internals.
      yield* Console.log(JSON.stringify(encodeConfig(cfg), null, "\t"));
      return;
    }

    const k = args.key.value;

    if (Option.isNone(args.value)) {
      if (k === "syncIntervalMinutes") {
        yield* Console.log(String(cfg.syncIntervalMinutes));
      } else if (k === "version") {
        yield* Console.log(String(cfg.version));
      } else {
        return yield* new UnknownConfigKeyError({ key: k });
      }
      return;
    }

    if (k === "syncIntervalMinutes") {
      const num = parseSyncInterval(args.value.value);
      if (num === undefined) {
        return yield* Effect.fail(
          new InvalidConfigValueError({
            message: `syncIntervalMinutes must be a whole number of 1 or more, got "${args.value.value}"`,
          }),
        );
      }
      yield* configService.update(
        (current) => new ShelfConfig({ ...current, syncIntervalMinutes: num }),
      );
      yield* Console.log(`Set syncIntervalMinutes = ${num}`);
    } else {
      return yield* new UnknownConfigKeyError({ key: k });
    }
  }),
).pipe(Command.withDescription("View or modify shelf configuration"));
