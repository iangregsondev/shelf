import { describe, test, expect } from "vite-plus/test";
import {
  stripSemverRange,
  parseRemoteTags,
  findMatchingTag,
} from "../../../src/domain/repo/pin-utils";

describe("pin-utils", () => {
  describe("stripSemverRange", () => {
    test("strips ^ prefix", () => {
      expect(stripSemverRange("^1.2.3")).toBe("1.2.3");
    });

    test("strips ~ prefix", () => {
      expect(stripSemverRange("~1.2.3")).toBe("1.2.3");
    });

    test("strips >= prefix", () => {
      expect(stripSemverRange(">=1.0.0")).toBe("1.0.0");
    });

    test("passes through bare version", () => {
      expect(stripSemverRange("1.2.3")).toBe("1.2.3");
    });

    test("handles prerelease versions", () => {
      expect(stripSemverRange("^4.0.0-beta.31")).toBe("4.0.0-beta.31");
    });
  });

  describe("parseRemoteTags", () => {
    test("parses ls-remote output", () => {
      const output = [
        "abc123\trefs/tags/v1.0.0",
        "def456\trefs/tags/v2.0.0",
        "ghi789\trefs/tags/v2.0.0^{}",
      ].join("\n");
      const tags = parseRemoteTags(output);
      expect(tags.has("v1.0.0")).toBe(true);
      expect(tags.has("v2.0.0")).toBe(true);
      expect(tags.has("v2.0.0^{}")).toBe(false);
      expect(tags.size).toBe(2);
    });

    test("handles empty output", () => {
      expect(parseRemoteTags("").size).toBe(0);
    });

    test("skips blank lines and lines with no ref column", () => {
      const output = "\n  \nabc123\nnot-a-ref-line\ndef456\trefs/tags/v1.0.0\n";
      expect([...parseRemoteTags(output)]).toEqual(["v1.0.0"]);
    });

    test("ignores non-tag refs", () => {
      const output = "abc123\trefs/heads/main\ndef456\trefs/tags/v1.0.0";
      const tags = parseRemoteTags(output);
      expect(tags.size).toBe(1);
      expect(tags.has("v1.0.0")).toBe(true);
    });
  });

  describe("findMatchingTag", () => {
    // Each row: the package the user named, the version their project
    // declares, the remote's tags, and the tag auto-pin should choose.
    const cases: ReadonlyArray<{
      name: string;
      packageName: string;
      version: string;
      tags: ReadonlyArray<string>;
      expected: string | null;
    }> = [
      {
        name: "scoped package matches its full scoped tag",
        packageName: "@effect/platform",
        version: "0.69.2",
        tags: ["effect@3.10.2", "@effect/platform@0.69.2", "@effect/sql@0.69.2"],
        expected: "@effect/platform@0.69.2",
      },
      {
        name: "scoped package falls back to its unscoped name tag",
        packageName: "@scope/widget",
        version: "1.2.3",
        tags: ["widget@1.2.3", "other@1.2.3"],
        expected: "widget@1.2.3",
      },
      {
        name: "plain package matches name@version",
        packageName: "effect",
        version: "3.10.2",
        tags: ["@effect/platform@3.10.2", "effect@3.10.2"],
        expected: "effect@3.10.2",
      },
      {
        name: "package-specific tag beats a repo-wide v tag",
        packageName: "@effect/platform",
        version: "1.0.0",
        tags: ["v1.0.0", "@effect/platform@1.0.0"],
        expected: "@effect/platform@1.0.0",
      },
      {
        name: "falls back to v-prefixed tag",
        packageName: "typescript",
        version: "5.4.0",
        tags: ["v5.4.0", "5.4.0"],
        expected: "v5.4.0",
      },
      {
        name: "falls back to bare version tag",
        packageName: "@scope/widget",
        version: "1.2.3",
        tags: ["1.2.3"],
        expected: "1.2.3",
      },
      {
        name: "prerelease version matches exactly",
        packageName: "@effect/platform-node",
        version: "4.0.0-beta.31",
        tags: ["@effect/platform-node@4.0.0-beta.3", "@effect/platform-node@4.0.0-beta.31"],
        expected: "@effect/platform-node@4.0.0-beta.31",
      },
      {
        name: "another package's tag never matches",
        packageName: "@effect/platform",
        version: "0.69.2",
        tags: ["@effect/sql@0.69.2", "effect@0.69.2"],
        expected: null,
      },
      {
        name: "no tag for the version",
        packageName: "effect",
        version: "1.0.0",
        tags: ["v2.0.0", "effect@2.0.0"],
        expected: null,
      },
    ];

    for (const c of cases) {
      test(c.name, () => {
        expect(findMatchingTag(c.packageName, c.version, new Set(c.tags))).toBe(c.expected);
      });
    }
  });
});
