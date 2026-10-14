import { describe, test, expect } from "bun:test";
import { parseSymrefHead } from "../../../src/domain/git/git-utils";

describe("parseSymrefHead", () => {
	test("reads the default branch from ls-remote --symref output", () => {
		const output = "ref: refs/heads/main\tHEAD\n2f1c0e9a6b4d3c2b1a09f8e7d6c5b4a392817160\tHEAD";
		expect(parseSymrefHead(output)).toBe("main");
	});

	test("keeps slashes in branch names", () => {
		expect(parseSymrefHead("ref: refs/heads/release/2.x\tHEAD")).toBe("release/2.x");
	});

	test("returns undefined when the remote reports no symbolic HEAD", () => {
		expect(parseSymrefHead("2f1c0e9a6b4d3c2b1a09f8e7d6c5b4a392817160\tHEAD")).toBeUndefined();
	});
});
