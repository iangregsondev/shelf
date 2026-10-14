import * as Option from "effect/Option";
import type { RepoPin } from "../config/config-schema";
import type { Shelffile, ShelffileEntry } from "./shelffile-schema";
import { ShelffileParseError } from "./shelffile-errors";
import { aliasProblem } from "../config/config-utils";
import { isFullCommitHash, parsePin } from "../repo/repo-utils";

export const parseShelffilePin = (raw: string): RepoPin => {
  if (!raw.startsWith("pin:")) {
    throw new ShelffileParseError({
      message: `Invalid pin format: "${raw}" (must start with "pin:")`,
    });
  }
  // Same forms as `shelf pin`, except a bare name: a shelffile is read
  // offline, so there is no remote to decide whether it is a tag or a branch.
  const input = parsePin(raw.slice(4));
  if (input._tag === "Explicit") return input.pin;
  throw new ShelffileParseError({
    message: `Invalid pin format: "${raw}" (expected pin:branch:<name>, pin:tag:<name>, pin:commit:<hash> or pin:<40-char-hash>)`,
  });
};

export const parseShelffileLine = (line: string, lineNumber: number): ShelffileEntry => {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2) {
    throw new ShelffileParseError({
      message: `Line ${lineNumber}: expected at least "alias url", got "${line.trim()}"`,
    });
  }
  const alias = parts[0] as string;
  const problem = aliasProblem(alias);
  if (problem !== undefined) {
    throw new ShelffileParseError({
      message: `Line ${lineNumber}: invalid alias "${alias}": ${problem}`,
    });
  }
  const url = parts[1] as string;
  let pin: Option.Option<RepoPin> = Option.none();
  if (parts.length >= 3) {
    pin = Option.some(parseShelffilePin(parts[2] as string));
  }
  return { alias, url, pin };
};

// A `#` starts a comment at the start of a line or after whitespace, so a
// URL fragment like `repo.git#readme` stays part of the URL.
const stripComment = (line: string): string => line.replace(/(^|\s)#.*$/, "").trim();

export const parseShelffile = (content: string): Shelffile => {
  const entries: ShelffileEntry[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i] as string);
    if (line === "") continue;
    entries.push(parseShelffileLine(line, i + 1));
  }
  return { entries };
};

/**
 * Every alias a shelffile might reference, read leniently: the first word of
 * each non-comment line, whether or not the line parses. Prune uses this to
 * keep repos a broken shelffile may still want.
 */
export const possibleShelffileAliases = (content: string): ReadonlySet<string> => {
  const aliases = new Set<string>();
  for (const raw of content.split("\n")) {
    const first = stripComment(raw).split(/\s+/)[0];
    if (first !== undefined && first !== "") aliases.add(first);
  }
  return aliases;
};

export const serializeShelffile = (shelffile: Shelffile): string => {
  const lines: string[] = [];
  for (const entry of shelffile.entries) {
    let line = `${entry.alias} ${entry.url}`;
    if (Option.isSome(entry.pin)) {
      const p = entry.pin.value;
      // A full hash is written bare; a short one (from an older config) keeps
      // its `commit:` prefix so it still parses back.
      line +=
        p.type === "commit" && isFullCommitHash(p.value)
          ? ` pin:${p.value}`
          : ` pin:${p.type}:${p.value}`;
    }
    lines.push(line);
  }
  return `${lines.join("\n")}\n`;
};
