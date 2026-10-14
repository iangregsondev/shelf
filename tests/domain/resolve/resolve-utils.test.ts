import { describe, expect, test } from "vite-plus/test";
import {
	expandOwnerRepo,
	expandPrefixed,
	deriveAliasFromOwnerRepo,
	githubApiBaseUrl,
} from "../../../src/domain/resolve/resolve-utils";

describe("expandOwnerRepo", () => {
	test("expands to GitHub HTTPS URL", () => {
		expect(expandOwnerRepo("facebook/react")).toBe("https://github.com/facebook/react.git");
		expect(expandOwnerRepo("Effect-TS/effect")).toBe("https://github.com/Effect-TS/effect.git");
	});
});

describe("expandPrefixed", () => {
	test("expands github prefix", () => {
		const result = expandPrefixed("github:facebook/react");
		expect(result.url).toBe("https://github.com/facebook/react.git");
		expect(result.host).toBe("github.com");
		expect(result.ownerRepo).toBe("facebook/react");
	});

	test("expands gitlab prefix", () => {
		const result = expandPrefixed("gitlab:org/repo");
		expect(result.url).toBe("https://gitlab.com/org/repo.git");
		expect(result.host).toBe("gitlab.com");
	});

	test("expands bitbucket prefix", () => {
		const result = expandPrefixed("bitbucket:org/repo");
		expect(result.url).toBe("https://bitbucket.org/org/repo.git");
		expect(result.host).toBe("bitbucket.org");
	});
});

describe("deriveAliasFromOwnerRepo", () => {
	test("uses the repo name as alias", () => {
		expect(deriveAliasFromOwnerRepo("facebook/react")).toBe("react");
		expect(deriveAliasFromOwnerRepo("Effect-TS/effect")).toBe("effect");
	});

	test("strips .git suffix", () => {
		expect(deriveAliasFromOwnerRepo("facebook/react.git")).toBe("react");
	});
});

describe("githubApiBaseUrl", () => {
	test("defaults to the public GitHub API", () => {
		expect(githubApiBaseUrl({})).toBe("https://api.github.com");
	});

	test("ignores an empty SHELF_GITHUB_API_URL", () => {
		expect(githubApiBaseUrl({ SHELF_GITHUB_API_URL: "" })).toBe("https://api.github.com");
	});

	test("uses SHELF_GITHUB_API_URL without a trailing slash", () => {
		expect(githubApiBaseUrl({ SHELF_GITHUB_API_URL: "http://127.0.0.1:4874/github/" })).toBe(
			"http://127.0.0.1:4874/github",
		);
	});
});

describe("deriveAliasFromOwnerRepo safety", () => {
	test.each([
		["owner/.hidden", "hidden"],
		["owner/..", "repo"],
		["owner/v2", "v2"],
	])("%j gives %j", (ownerRepo, expected) => {
		expect(deriveAliasFromOwnerRepo(ownerRepo)).toBe(expected);
	});
});
