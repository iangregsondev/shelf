import * as Option from "effect/Option";
import { RepoPin } from "../config/config-schema";
import type { Shelffile, ShelffileEntry } from "./shelffile-schema";
import { ShelffileParseError } from "./shelffile-errors";
import { aliasProblem } from "../repo/repo-utils";

export const parseShelffilePin = (raw: string): RepoPin => {
	if (!raw.startsWith("pin:")) {
		throw new ShelffileParseError({
			message: `Invalid pin format: "${raw}" (must start with "pin:")`,
		});
	}
	const rest = raw.slice(4);
	if (rest.startsWith("branch:")) {
		return new RepoPin({ type: "branch", value: rest.slice(7) });
	}
	if (rest.startsWith("tag:")) {
		return new RepoPin({ type: "tag", value: rest.slice(4) });
	}
	if (rest.startsWith("commit:") && /^[0-9a-f]{4,40}$/i.test(rest.slice(7))) {
		return new RepoPin({ type: "commit", value: rest.slice(7) });
	}
	if (/^[0-9a-f]{40}$/i.test(rest)) {
		return new RepoPin({ type: "commit", value: rest });
	}
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

export const serializeShelffile = (shelffile: Shelffile): string => {
	const lines: string[] = [];
	for (const entry of shelffile.entries) {
		let line = `${entry.alias} ${entry.url}`;
		if (Option.isSome(entry.pin)) {
			const p = entry.pin.value;
			// A full hash is written bare; a short one (from an older config) keeps
			// its `commit:` prefix so it still parses back.
			line +=
				p.type === "commit" && /^[0-9a-f]{40}$/i.test(p.value)
					? ` pin:${p.value}`
					: ` pin:${p.type}:${p.value}`;
		}
		lines.push(line);
	}
	return `${lines.join("\n")}\n`;
};
