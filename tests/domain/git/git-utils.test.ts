import { describe, test, expect } from "vite-plus/test";
import { gitErrorLine, parseSymrefHead } from "../../../src/domain/git/git-utils";

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

describe("gitErrorLine", () => {
  test("picks the first fatal: or error: line", () => {
    const stderr = [
      "remote: Counting objects",
      "fatal: '/x.git' does not appear to be a git repository",
      "fatal: Could not read from remote repository.",
      "",
      "Please make sure you have the correct access rights",
    ].join("\n");
    expect(gitErrorLine(stderr)).toBe("fatal: '/x.git' does not appear to be a git repository");
    expect(gitErrorLine("hint: x\nerror: pathspec 'y' did not match")).toBe(
      "error: pathspec 'y' did not match",
    );
  });

  test("falls back to the last non-empty line", () => {
    expect(gitErrorLine("first\nsecond\n\n")).toBe("second");
    expect(gitErrorLine("only")).toBe("only");
  });

  test("returns an empty string when stderr holds only whitespace", () => {
    expect(gitErrorLine("")).toBe("");
    expect(gitErrorLine("  \n\t\n")).toBe("");
  });
});
