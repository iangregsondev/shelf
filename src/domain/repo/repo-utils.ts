import * as Effect from "effect/Effect";
import { statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { RepoPin } from "../config/config-schema";
import { InvalidAliasError } from "./repo-errors";

const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ALIAS_MAX_LENGTH = 100;

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

const FALLBACK_ALIAS = "repo";
const SCOPED_PACKAGE_PATTERN = /^@([^/]+)\/([^/]+)$/;
const GO_MAJOR_VERSION_PATTERN = /^v\d+$/;

/** Turns any name into a valid alias: unsafe characters become `-`, leading `.`, `_`, `-` go. */
export const toSafeAlias = (name: string): string => {
	const safe = name
		.replaceAll(/[^A-Za-z0-9._-]/g, "-")
		.replace(/^[._-]+/, "")
		.slice(0, ALIAS_MAX_LENGTH);
	return aliasProblem(safe) === undefined ? safe : FALLBACK_ALIAS;
};

/**
 * Derives an alias from a git URL, a path, a Go module path or a package name.
 * Never throws, and always returns a valid alias. A scoped package
 * `@scope/name` gives `scope-name`; a Go module ending in a `/vN` major
 * version gives the segment before it (`.../chi/v5` gives `chi`).
 */
export const deriveAlias = (url: string): string => {
	const scoped = SCOPED_PACKAGE_PATTERN.exec(url);
	if (scoped) return toSafeAlias(`${scoped[1]}-${scoped[2]}`);
	let cleaned = url.replace(/\/+$/, "").replace(/\.git$/, "");
	// Handle git@ URLs: git@github.com:user/repo
	if (cleaned.startsWith("git@")) {
		const colonIndex = cleaned.indexOf(":");
		if (colonIndex !== -1) {
			cleaned = cleaned.slice(colonIndex + 1);
		}
	}
	// Handle scheme URLs; an unparsable one falls back to its raw path text
	if (cleaned.includes("://")) {
		cleaned = URL.canParse(cleaned)
			? new URL(cleaned).pathname
			: cleaned.slice(cleaned.indexOf("://") + 3);
	}
	const segments = cleaned.split("/").filter((s) => s.length > 0);
	const last = segments.at(-1);
	const name =
		last !== undefined && segments.length > 1 && GO_MAJOR_VERSION_PATTERN.test(last)
			? segments.at(-2)
			: last;
	return toSafeAlias((name ?? "").replace(/\.git$/, ""));
};

/** What the user typed as a pin: a pin taken as stated, a bare name for the remote to decide, or a mistake. */
export type PinInput =
	| { readonly _tag: "Explicit"; readonly pin: RepoPin }
	| { readonly _tag: "Bare"; readonly value: string }
	| { readonly _tag: "Invalid"; readonly message: string };

const FULL_HASH = /^[0-9a-f]{40}$/i;
const COMMIT_HASH = /^[0-9a-f]{4,40}$/i;

/**
 * Reads a pin the user typed. `branch:`, `tag:` and `commit:` forms, and a
 * full 40-character hash, are taken as stated. Anything else is a bare name
 * the remote decides (see `pinFromRemoteRefs`), so a hex-looking name like
 * `cafe123` is never guessed to be a commit.
 */
export const parsePin = (raw: string): PinInput => {
	const explicit = (type: RepoPin["type"], value: string): PinInput =>
		value === ""
			? { _tag: "Invalid", message: `Pin "${raw}" names no ${type}` }
			: { _tag: "Explicit", pin: new RepoPin({ type, value }) };
	if (raw.startsWith("branch:")) return explicit("branch", raw.slice(7));
	if (raw.startsWith("tag:")) return explicit("tag", raw.slice(4));
	if (raw.startsWith("commit:")) {
		const hash = raw.slice(7);
		return COMMIT_HASH.test(hash)
			? explicit("commit", hash)
			: { _tag: "Invalid", message: `Pin "${raw}" is not a commit hash (4 to 40 hex characters)` };
	}
	if (FULL_HASH.test(raw)) return explicit("commit", raw);
	if (raw === "") return { _tag: "Invalid", message: "Pin is empty" };
	return { _tag: "Bare", value: raw };
};

/**
 * Decides a bare pin from `git ls-remote --heads --tags` output: a tag of
 * that name wins, then a branch; `undefined` when the remote has neither.
 */
export const pinFromRemoteRefs = (name: string, lsRemoteOutput: string): RepoPin | undefined => {
	const refs = new Set(
		lsRemoteOutput
			.split("\n")
			.map((line) => line.trim().split("\t")[1])
			.filter((ref): ref is string => ref !== undefined),
	);
	if (refs.has(`refs/tags/${name}`)) return new RepoPin({ type: "tag", value: name });
	if (refs.has(`refs/heads/${name}`)) return new RepoPin({ type: "branch", value: name });
	return undefined;
};

export const dirSize = (dirPath: string): Effect.Effect<number> =>
	Effect.try({
		try: () => {
			let total = 0;
			const stack = [dirPath];
			while (stack.length > 0) {
				const current = stack.pop() as string;
				const entries = readdirSync(current, { withFileTypes: true });
				for (const entry of entries) {
					const fullPath = join(current, entry.name);
					if (entry.isDirectory()) {
						stack.push(fullPath);
					} else {
						total += statSync(fullPath).size;
					}
				}
			}
			return total;
		},
		catch: () => 0,
	}).pipe(Effect.orElseSucceed(() => 0));

/** Succeeds with the alias when it is a single safe folder name, else fails with `InvalidAliasError`. */
export const checkAlias = (alias: string): Effect.Effect<string, InvalidAliasError> => {
	const problem = aliasProblem(alias);
	return problem === undefined
		? Effect.succeed(alias)
		: Effect.fail(new InvalidAliasError({ alias, message: problem }));
};
