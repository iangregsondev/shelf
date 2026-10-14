import { describe, test, expect } from "bun:test";
import { aliasProblem, deriveAlias } from "../../../src/domain/repo/repo-utils";

describe("deriveAlias", () => {
	test("derives from HTTPS URL", () => {
		expect(deriveAlias("https://github.com/Effect-TS/effect.git")).toBe("effect");
	});

	test("derives from git@ URL", () => {
		expect(deriveAlias("git@github.com:Effect-TS/effect.git")).toBe("effect");
	});

	test("strips .git suffix", () => {
		expect(deriveAlias("https://github.com/user/my-repo.git")).toBe("my-repo");
	});

	test("handles trailing slashes", () => {
		expect(deriveAlias("https://github.com/user/my-repo/")).toBe("my-repo");
	});

	test("handles URL without .git suffix", () => {
		expect(deriveAlias("https://github.com/user/my-repo")).toBe("my-repo");
	});

	test("handles git@ URL with trailing slash", () => {
		expect(deriveAlias("git@github.com:user/my-repo.git/")).toBe("my-repo");
	});

	test("handles simple path-like URL", () => {
		expect(deriveAlias("https://gitlab.com/group/subgroup/project")).toBe("project");
	});
});

describe("aliasProblem", () => {
	test.each([["effect"], ["my-repo"], ["next.js"], ["a_b"], ["V2"], ["0"], ["a".repeat(100)]])(
		"accepts %p",
		(alias) => {
			expect(aliasProblem(alias)).toBeUndefined();
		},
	);

	test.each([
		[""],
		["."],
		[".."],
		["../escape"],
		["a/b"],
		[String.raw`a\b`],
		["/abs"],
		[".hidden"],
		["-flag"],
		["_lead"],
		["@scope"],
		["has space"],
		["a".repeat(101)],
		["~"],
	])("rejects %p", (alias) => {
		expect(aliasProblem(alias)).toBeString();
	});
});

describe("deriveAlias edge cases", () => {
	test.each([
		["github.com/go-chi/chi/v5", "chi"],
		["https://github.com/go-chi/chi/v5", "chi"],
		["github.com/jackc/pgx/v10", "pgx"],
		["github.com/gin-gonic/gin", "gin"],
		["@effect/platform", "effect-platform"],
		["https://example.com/a/.git", "a"],
		["https://github.com/user/..", "repo"],
		["https://example.com/a/.hidden", "hidden"],
		["https://example.com/a/my%20repo", "my-20repo"],
		["/tmp/some dir/repo.git", "repo"],
		["v5", "v5"],
		["", "repo"],
	])("%p gives %p", (input, expected) => {
		expect(deriveAlias(input)).toBe(expected);
	});

	test.each([["https://[bad"], ["http://exa mple.com/x"], ["https://"], ["git@:"]])(
		"never throws on unparsable %p and gives a valid alias",
		(input) => {
			const alias = deriveAlias(input);
			expect(aliasProblem(alias)).toBeUndefined();
		},
	);

	test("cuts a long name to 100 characters", () => {
		const alias = deriveAlias(`https://example.com/x/${"a".repeat(150)}`);
		expect(alias).toBe("a".repeat(100));
	});
});
