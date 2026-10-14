import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as Effect from "effect/Effect";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	aliasProblem,
	deriveAlias,
	dirSize,
	parsePin,
	pinFromRemoteRefs,
} from "../../../src/domain/repo/repo-utils";

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

describe("parsePin", () => {
	const explicit = (raw: string) => {
		const parsed = parsePin(raw);
		if (parsed._tag !== "Explicit") throw new Error(`expected an explicit pin, got ${parsed._tag}`);
		return { type: parsed.pin.type, value: parsed.pin.value };
	};

	test.each([
		["branch:main", "branch", "main"],
		["branch:cafe123", "branch", "cafe123"],
		["tag:v1.2.3", "tag", "v1.2.3"],
		["commit:abc1234", "commit", "abc1234"],
		["commit:ABC1234", "commit", "ABC1234"],
		[
			"0123456789abcdef0123456789abcdef01234567",
			"commit",
			"0123456789abcdef0123456789abcdef01234567",
		],
	] as const)("%s is taken as stated", (raw, type, value) => {
		expect(explicit(raw)).toEqual({ type, value });
	});

	test.each(["v1.2.3", "main", "cafe123", "feature/x", "0123456789abcdef0123456789abcdef0123456"])(
		"bare %s is left for the remote to decide",
		(raw) => {
			expect(parsePin(raw)).toEqual({ _tag: "Bare", value: raw });
		},
	);

	test.each(["branch:", "tag:", "commit:", "commit:xyz1234", "commit:abc", ""])(
		"%s is rejected",
		(raw) => {
			expect(parsePin(raw)._tag).toBe("Invalid");
		},
	);
});

describe("pinFromRemoteRefs", () => {
	const lsRemote = [
		"1111111111111111111111111111111111111111\trefs/heads/main",
		"2222222222222222222222222222222222222222\trefs/heads/release",
		"3333333333333333333333333333333333333333\trefs/tags/v1.2.3",
		"4444444444444444444444444444444444444444\trefs/tags/v1.2.3^{}",
		"5555555555555555555555555555555555555555\trefs/tags/release",
		"6666666666666666666666666666666666666666\trefs/heads/feature/x",
	].join("\n");

	test("a tag on the remote gives a tag pin", () => {
		expect(pinFromRemoteRefs("v1.2.3", lsRemote)).toEqual({ type: "tag", value: "v1.2.3" });
	});

	test("a branch on the remote gives a branch pin", () => {
		expect(pinFromRemoteRefs("main", lsRemote)).toEqual({ type: "branch", value: "main" });
		expect(pinFromRemoteRefs("feature/x", lsRemote)).toEqual({
			type: "branch",
			value: "feature/x",
		});
	});

	test("a tag wins over a branch of the same name", () => {
		expect(pinFromRemoteRefs("release", lsRemote)).toEqual({ type: "tag", value: "release" });
	});

	test("a name the remote doesn't have gives nothing", () => {
		expect(pinFromRemoteRefs("v9.9.9", lsRemote)).toBeUndefined();
		expect(pinFromRemoteRefs("feature", lsRemote)).toBeUndefined();
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

describe("dirSize", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "shelf-dirsize-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("an empty folder is 0 bytes", async () => {
		expect(await Effect.runPromise(dirSize(dir))).toBe(0);
	});

	test("adds up the bytes of every file in nested folders", async () => {
		await Bun.write(join(dir, "a.txt"), "12345");
		await mkdir(join(dir, "sub", "deeper"), { recursive: true });
		await Bun.write(join(dir, "sub", "b.txt"), "123");
		await Bun.write(join(dir, "sub", "deeper", "c.txt"), "1234567890");
		expect(await Effect.runPromise(dirSize(dir))).toBe(18);
	});

	test("a missing folder is 0 bytes rather than an error", async () => {
		expect(await Effect.runPromise(dirSize(join(dir, "missing")))).toBe(0);
	});

	test("a broken symlink does not zero out the rest of the folder", async () => {
		await Bun.write(join(dir, "a.txt"), "12345");
		await symlink(join(dir, "nowhere"), join(dir, "dangling"));
		const size = await Effect.runPromise(dirSize(dir));
		expect(size).toBeGreaterThanOrEqual(5);
	});
});
