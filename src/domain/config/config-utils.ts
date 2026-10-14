import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import { join, resolve } from "node:path";
import { InvalidAliasError } from "./config-errors";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The shelf home: `SHELF_HOME` when set and non-empty (relative paths resolve
 * against `cwd`), otherwise `~/.agents/shelf`.
 */
export const resolveShelfHome = (env: Env, homeDir: string, cwd: string): string => {
  const override = env["SHELF_HOME"];
  if (override !== undefined && override !== "") {
    return resolve(cwd, override);
  }
  return join(homeDir, ".agents", "shelf");
};

/** A sync interval typed by the user: a whole number of minutes, 1 or more. */
export const parseSyncInterval = (raw: string): number | undefined => {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const minutes = Number(trimmed);
  return Number.isSafeInteger(minutes) && minutes >= 1 ? minutes : undefined;
};

/** The `code` of a Node file-system error (`ENOENT`, `EEXIST`, ...), if it has one. */
export const errorCode = (error: unknown): string | undefined =>
  error !== null && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;

/**
 * The Node error that an Effect `FileSystem` failure wraps, which carries the
 * errno `code` and Node's own message (`ENOENT: no such file or directory, ...`);
 * any other error as is.
 */
export const osError = (error: unknown): unknown =>
  PlatformError.isPlatformError(error) && error.reason.cause !== undefined
    ? error.reason.cause
    : error;

/** The message of `error`, or of the Node error it wraps (see `osError`). */
export const osErrorMessage = (error: unknown): string => {
  const cause = osError(error);
  return cause instanceof Error ? cause.message : String(cause);
};

const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const ALIAS_MAX_LENGTH = 100;

/**
 * Why an alias is not a single safe folder name, or `undefined` when it is.
 * The rule: letters, digits, `.`, `_` and `-`, starting with a letter or digit,
 * at most 100 characters (so never `.` or `..`).
 */
export const aliasProblem = (alias: string): string | undefined => {
  if (alias.length > ALIAS_MAX_LENGTH) {
    return `must be at most ${ALIAS_MAX_LENGTH} characters`;
  }
  if (!ALIAS_PATTERN.test(alias)) {
    return "must start with a letter or digit and use only letters, digits, '.', '_' and '-'";
  }
  return undefined;
};

/** Succeeds with the alias when it is a single safe folder name, else fails with `InvalidAliasError`. */
export const checkAlias = (alias: string): Effect.Effect<string, InvalidAliasError> => {
  const problem = aliasProblem(alias);
  return problem === undefined
    ? Effect.succeed(alias)
    : Effect.fail(new InvalidAliasError({ alias, message: problem }));
};
