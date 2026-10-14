import { describe, expect, test } from "bun:test";
import { lookupBuiltin, resolveLocally } from "../../../src/domain/resolve/resolve-utils";

describe("resolveLocally", () => {
	describe("uses URL forms as the remote", () => {
		test.each([
			["https://github.com/facebook/react.git", "https://github.com/facebook/react.git", "react"],
			["http://example.com/repo.git", "http://example.com/repo.git", "repo"],
			["ssh://git@github.com/org/lib.git", "ssh://git@github.com/org/lib.git", "lib"],
			["git://example.com/org/lib.git", "git://example.com/org/lib.git", "lib"],
			["file:///tmp/repos/lib.git", "file:///tmp/repos/lib.git", "lib"],
			["git@github.com:org/lib.git", "git@github.com:org/lib.git", "lib"],
			["git@gitlab.example.com:group/sub/lib", "git@gitlab.example.com:group/sub/lib", "lib"],
		])("%s", (input, url, alias) => {
			expect(resolveLocally(input)).toEqual({
				_tag: "Resolved",
				url,
				suggestedAlias: alias,
				source: "direct",
			});
		});
	});

	describe("reduces browser links to the repo", () => {
		test.each([
			["https://github.com/org/lib/tree/main/src", "https://github.com/org/lib"],
			["https://github.com/org/lib/blob/main/README.md", "https://github.com/org/lib"],
			["https://github.com/org/lib#readme", "https://github.com/org/lib"],
			["https://gitlab.com/group/lib/-/tree/main", "https://gitlab.com/group/lib"],
			["github.com/org/lib/tree/main", "https://github.com/org/lib"],
		])("%s", (input, url) => {
			const result = resolveLocally(input);
			expect(result._tag === "Resolved" && result.url).toBe(url);
			expect(result._tag === "Resolved" && result.suggestedAlias).toBe("lib");
		});
	});

	describe("rejects unparsable URLs with a clear message", () => {
		test.each([
			["https://", "is not a valid URL"],
			["http://[::1/repo.git", "is not a valid URL"],
			["https://github.com", "has no repository path"],
			["ftp://example.com/repo.git", 'unsupported URL scheme "ftp"'],
		])("%s", (input, message) => {
			const result = resolveLocally(input);
			expect(result._tag).toBe("Invalid");
			expect(result._tag === "Invalid" && result.message).toContain(message);
		});
	});

	describe("expands shorthands", () => {
		test.each([
			["/tmp/some-repo", "/tmp/some-repo", "some-repo", "direct"],
			["./local-repo", "./local-repo", "local-repo", "direct"],
			["~/repos/my-lib", "~/repos/my-lib", "my-lib", "direct"],
			["facebook/react", "https://github.com/facebook/react.git", "react", "owner-repo"],
			["vercel/next.js", "https://github.com/vercel/next.js.git", "next.js", "owner-repo"],
			["facebook/react.git", "https://github.com/facebook/react.git", "react", "owner-repo"],
			["facebook/react/", "https://github.com/facebook/react.git", "react", "owner-repo"],
			["github:vercel/next.js", "https://github.com/vercel/next.js.git", "next.js", "prefixed"],
			["gitlab:org/repo.git", "https://gitlab.com/org/repo.git", "repo", "prefixed"],
			["bitbucket:org/repo/", "https://bitbucket.org/org/repo.git", "repo", "prefixed"],
			["github.com/owner/repo", "https://github.com/owner/repo", "repo", "owner-repo"],
			[
				"gitlab.com/group/sub/repo.git",
				"https://gitlab.com/group/sub/repo.git",
				"repo",
				"owner-repo",
			],
		] as const)("%s", (input, url, alias, source) => {
			expect(resolveLocally(input)).toEqual({
				_tag: "Resolved",
				url,
				suggestedAlias: alias,
				source,
			});
		});
	});

	describe("bare names", () => {
		test("a built-in registry name resolves to its repo", () => {
			expect(resolveLocally("react")).toEqual({
				_tag: "Resolved",
				url: "https://github.com/facebook/react.git",
				suggestedAlias: "react",
				source: "registry",
			});
		});

		test.each(["toString", "constructor", "__proto__", "hasOwnProperty", "my-cool-lib"])(
			"%s is searched for, not read from the object prototype",
			(name) => {
				expect(resolveLocally(name)).toEqual({ _tag: "Search", name });
			},
		);
	});
});

describe("lookupBuiltin", () => {
	test("finds a known package", () => {
		expect(lookupBuiltin("zod")).toBe("https://github.com/colinhacks/zod.git");
	});

	test.each(["toString", "constructor", "__proto__", "valueOf"])("%s is not a package", (name) => {
		expect(lookupBuiltin(name)).toBeUndefined();
	});
});
