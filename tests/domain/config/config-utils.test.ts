import { describe, expect, test } from "vite-plus/test";
import * as PlatformError from "effect/PlatformError";
import * as Effect from "effect/Effect";
import {
  ALIAS_MAX_LENGTH,
  aliasProblem,
  checkAlias,
  errorCode,
  osError,
  osErrorMessage,
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

describe("errorCode", () => {
  test("gives the code of an error that has one, as a string", () => {
    expect(errorCode(Object.assign(new Error("gone"), { code: "ENOENT" }))).toBe("ENOENT");
    expect(errorCode({ code: 42 })).toBe("42");
  });

  test.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "ENOENT"],
    ["an error with no code", new Error("boom")],
  ])("gives undefined for %s", (_name, value) => {
    expect(errorCode(value)).toBeUndefined();
  });
});

describe("osErrorMessage", () => {
  test("gives the message of the Node error a FileSystem failure wraps", () => {
    const wrapped = PlatformError.systemError({
      _tag: "NotFound",
      module: "FileSystem",
      method: "readFile",
      cause: new Error("ENOENT: no such file or directory, open '/x'"),
    });
    expect(osErrorMessage(wrapped)).toBe("ENOENT: no such file or directory, open '/x'");
  });

  test("gives the message of a plain error", () => {
    expect(osErrorMessage(new Error("boom"))).toBe("boom");
  });

  test("gives anything that is not an error as text", () => {
    expect(osErrorMessage("disk on fire")).toBe("disk on fire");
    expect(osErrorMessage(7)).toBe("7");
  });
});

describe("aliasProblem", () => {
  test.each(["react", "my-repo", "a.b_c-1", "9lives", "x".repeat(ALIAS_MAX_LENGTH)])(
    "accepts %j",
    (alias) => {
      expect(aliasProblem(alias)).toBeUndefined();
    },
  );

  test.each(["", ".", "..", "../outside", "a/b", "-flag", ".hidden", "_x", "sp ace", "a\\b"])(
    "rejects %j as not a safe folder name",
    (alias) => {
      expect(aliasProblem(alias)).toBe(
        "must start with a letter or digit and use only letters, digits, '.', '_' and '-'",
      );
    },
  );

  test("rejects an alias longer than the limit", () => {
    expect(aliasProblem("x".repeat(ALIAS_MAX_LENGTH + 1))).toBe("must be at most 100 characters");
  });
});

describe("checkAlias", () => {
  test("succeeds with a safe alias", async () => {
    expect(await Effect.runPromise(checkAlias("my-repo"))).toBe("my-repo");
  });

  test("fails with InvalidAliasError naming the alias and the problem", async () => {
    const error = await Effect.runPromise(Effect.flip(checkAlias("../x")));
    expect(error._tag).toBe("InvalidAliasError");
    expect(error.alias).toBe("../x");
    expect(error.message).toBe(
      "must start with a letter or digit and use only letters, digits, '.', '_' and '-'",
    );
  });
});
