import { describe, expect, test } from "vite-plus/test";
import * as Option from "effect/Option";
import { resolveGoModule, normalizeGitUrl } from "../../../src/domain/detect/detect-utils";

describe("resolveGoModule", () => {
	test("resolves github.com modules to git URLs", () => {
		const result = resolveGoModule("github.com/gin-gonic/gin");
		expect(Option.isSome(result)).toBe(true);
		if (Option.isSome(result)) {
			expect(result.value).toBe("https://github.com/gin-gonic/gin.git");
		}
	});

	test("handles nested github paths (takes first two segments)", () => {
		const result = resolveGoModule("github.com/gorilla/mux");
		expect(Option.isSome(result)).toBe(true);
		if (Option.isSome(result)) {
			expect(result.value).toBe("https://github.com/gorilla/mux.git");
		}
	});

	test("handles deeply nested github paths", () => {
		const result = resolveGoModule("github.com/aws/aws-sdk-go/service/s3");
		expect(Option.isSome(result)).toBe(true);
		if (Option.isSome(result)) {
			expect(result.value).toBe("https://github.com/aws/aws-sdk-go.git");
		}
	});

	test("returns none for non-github modules", () => {
		const result = resolveGoModule("golang.org/x/text");
		expect(Option.isNone(result)).toBe(true);
	});

	test("returns none for incomplete github paths", () => {
		const result = resolveGoModule("github.com/onlyowner");
		expect(Option.isNone(result)).toBe(true);
	});

	test("returns none for empty string", () => {
		const result = resolveGoModule("");
		expect(Option.isNone(result)).toBe(true);
	});
});

describe("normalizeGitUrl", () => {
	test("strips git+ prefix", () => {
		expect(normalizeGitUrl("git+https://github.com/org/repo")).toBe(
			"https://github.com/org/repo.git",
		);
	});

	test("converts git:// to https://", () => {
		expect(normalizeGitUrl("git://github.com/org/repo")).toBe("https://github.com/org/repo.git");
	});

	test("converts ssh://git@ to https://", () => {
		expect(normalizeGitUrl("ssh://git@github.com/org/repo")).toBe(
			"https://github.com/org/repo.git",
		);
	});

	test("expands github: shorthand", () => {
		expect(normalizeGitUrl("github:org/repo")).toBe("https://github.com/org/repo.git");
	});

	test("appends .git if missing", () => {
		expect(normalizeGitUrl("https://github.com/org/repo")).toBe("https://github.com/org/repo.git");
	});

	test("preserves .git if already present", () => {
		expect(normalizeGitUrl("https://github.com/org/repo.git")).toBe(
			"https://github.com/org/repo.git",
		);
	});

	test.each([
		["org/repo", "https://github.com/org/repo.git"],
		["gitlab:group/repo", "https://gitlab.com/group/repo.git"],
		["bitbucket:team/repo", "https://bitbucket.org/team/repo.git"],
		["https://github.com/org/repo#readme", "https://github.com/org/repo.git"],
		["git+https://github.com/org/repo.git#main", "https://github.com/org/repo.git"],
		["https://github.com/org/repo/tree/main/packages/core", "https://github.com/org/repo.git"],
		["https://github.com/org/repo/blob/main/README.md", "https://github.com/org/repo.git"],
		["https://gitlab.com/group/repo/-/tree/main", "https://gitlab.com/group/repo.git"],
		["https://github.com/org/repo/", "https://github.com/org/repo.git"],
		["git+ssh://git@github.com/org/repo.git", "https://github.com/org/repo.git"],
		["git@github.com:org/repo.git", "https://github.com/org/repo.git"],
	])("normalizes %s", (input, expected) => {
		expect(normalizeGitUrl(input)).toBe(expected);
	});
});
