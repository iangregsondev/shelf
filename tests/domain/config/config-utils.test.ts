import { describe, expect, test } from "vite-plus/test";
import * as PlatformError from "effect/PlatformError";
import {
  errorCode,
  osError,
  parseSyncInterval,
  resolveShelfHome,
} from "../../../src/domain/config/config-utils";

describe("osError", () => {
  test("unwraps the Node error a FileSystem failure carries", () => {
    const nodeError = Object.assign(new Error("ENOTDIR: not a directory, stat '/a/b'"), {
      code: "ENOTDIR",
    });
    const wrapped = PlatformError.systemError({
      _tag: "BadResource",
      module: "FileSystem",
      method: "stat",
      pathOrDescriptor: "/a/b",
      cause: nodeError,
    });
    expect(osError(wrapped)).toBe(nodeError);
    expect(errorCode(osError(wrapped))).toBe("ENOTDIR");
  });

  test("gives any other error back as is", () => {
    const plain = new Error("boom");
    expect(osError(plain)).toBe(plain);
    const noCause = PlatformError.systemError({
      _tag: "NotFound",
      module: "FileSystem",
      method: "stat",
    });
    expect(osError(noCause)).toBe(noCause);
  });
});

describe("resolveShelfHome", () => {
  const cases: ReadonlyArray<{
    name: string;
    env: Record<string, string | undefined>;
    cwd: string;
    expected: string;
  }> = [
    {
      name: "defaults to ~/.agents/shelf",
      env: {},
      cwd: "/work",
      expected: "/home/u/.agents/shelf",
    },
    {
      name: "uses an absolute SHELF_HOME as given",
      env: { SHELF_HOME: "/tmp/my-shelf" },
      cwd: "/work",
      expected: "/tmp/my-shelf",
    },
    {
      name: "resolves a relative SHELF_HOME against the working directory",
      env: { SHELF_HOME: "caches/shelf" },
      cwd: "/work",
      expected: "/work/caches/shelf",
    },
    {
      name: "ignores an empty SHELF_HOME",
      env: { SHELF_HOME: "" },
      cwd: "/work",
      expected: "/home/u/.agents/shelf",
    },
    {
      name: "drops a trailing slash",
      env: { SHELF_HOME: "/tmp/my-shelf/" },
      cwd: "/work",
      expected: "/tmp/my-shelf",
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(resolveShelfHome(c.env, "/home/u", c.cwd)).toBe(c.expected);
    });
  }
});

describe("parseSyncInterval", () => {
  test.each([
    ["1", 1],
    ["60", 60],
    [" 15 ", 15],
  ])("accepts the whole number %j", (raw, expected) => {
    expect(parseSyncInterval(raw)).toBe(expected);
  });

  test.each(["0", "-5", "1.5", "2.0", "abc", "", "10m", "1e3", "Infinity"])("rejects %j", (raw) => {
    expect(parseSyncInterval(raw)).toBeUndefined();
  });
});
