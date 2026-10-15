import { describe, test, expect } from "vite-plus/test";
import * as Option from "effect/Option";
import { RepoPin } from "../../../src/domain/config/config-schema";
import { aliasProblem } from "../../../src/domain/config/config-utils";
import {
  declaredVersion,
  deriveAlias,
  describeLastSynced,
  describePin,
  parsePin,
  parseTempName,
  sameIgnoringCase,
  settleDeadTemp,
  pinFromRemoteRefs,
  tempName,
} from "../../../src/domain/repo/repo-utils";
import { TEMP_ID } from "../../helpers/process";

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
    "accepts %j",
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
  ])("rejects %j", (alias) => {
    expect(aliasProblem(alias)).toBeTypeOf("string");
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
    ["git@host/user/lib.git", "lib"],
    ["", "repo"],
  ])("%j gives %j", (input, expected) => {
    expect(deriveAlias(input)).toBe(expected);
  });

  test.each([["https://[bad"], ["http://exa mple.com/x"], ["https://"], ["git@:"]])(
    "never throws on unparsable %j and gives a valid alias",
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

describe("declaredVersion", () => {
  test("reads the version from dependencies", () => {
    expect(declaredVersion({ dependencies: { react: "^18.2.0" } }, "react")).toBe("^18.2.0");
  });

  test("falls back to devDependencies", () => {
    expect(
      declaredVersion(
        { dependencies: { vue: "3.0.0" }, devDependencies: { react: "~18.1.0" } },
        "react",
      ),
    ).toBe("~18.1.0");
  });

  test("prefers dependencies over devDependencies", () => {
    expect(
      declaredVersion(
        { dependencies: { react: "18.2.0" }, devDependencies: { react: "17.0.0" } },
        "react",
      ),
    ).toBe("18.2.0");
  });

  test("is undefined for a package the manifest doesn't declare", () => {
    expect(declaredVersion({ dependencies: { vue: "3.0.0" } }, "react")).toBeUndefined();
  });

  test("ignores names inherited from Object.prototype", () => {
    expect(declaredVersion({ dependencies: {} }, "constructor")).toBeUndefined();
  });

  test("ignores a version that isn't a string", () => {
    expect(declaredVersion({ dependencies: { react: 18 } }, "react")).toBeUndefined();
  });

  test("ignores dependency fields that aren't objects", () => {
    expect(
      declaredVersion({ dependencies: "react", devDependencies: null }, "react"),
    ).toBeUndefined();
  });

  test("is undefined for a null manifest", () => {
    expect(declaredVersion(null, "react")).toBeUndefined();
  });
});

describe("describePin", () => {
  test("names the default branch for an unpinned repo", () => {
    expect(describePin(Option.none())).toBe("(default branch)");
  });

  test.each([
    ["branch", "main", "branch:main"],
    ["tag", "v1.2.3", "tag:v1.2.3"],
    ["commit", "abc1234", "commit:abc1234"],
  ] as const)("gives a %s pin as type:value", (type, value, expected) => {
    expect(describePin(Option.some(new RepoPin({ type, value })))).toBe(expected);
  });
});

describe("describeLastSynced", () => {
  test("says never for a repo that has not synced", () => {
    expect(describeLastSynced(Option.none())).toBe("never");
  });

  test("gives the sync time as stored", () => {
    expect(describeLastSynced(Option.some("2026-01-01T00:00:00.000Z"))).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });
});

describe("temp folder names", () => {
  const id = TEMP_ID;

  test("name the kind, the alias, the owning process and an id", () => {
    expect(tempName("add", "my-lib", 4321, id)).toBe(`.shelf-add-my-lib-4321-${id}`);
  });

  test.each(["add", "rename", "removing", "trash"] as const)("read back a %s name", (kind) => {
    expect(parseTempName(tempName(kind, "my-lib-2", 4321, id))).toEqual({
      kind,
      alias: "my-lib-2",
      pid: 4321,
    });
  });

  test.each([
    ["a repo folder", "lib"],
    ["an unknown kind", `.shelf-copy-lib-4321-${id}`],
    ["a name with no process", `.shelf-add-lib-${id}`],
    ["a name with no id", ".shelf-add-lib-4321"],
    ["a name with no alias", `.shelf-add--4321-${id}`],
  ])("are not read from %s", (_label, name) => {
    expect(parseTempName(name)).toBeUndefined();
  });
});

describe("sameIgnoringCase", () => {
  test.each([
    ["react", "React", true],
    ["/x/repos/react", "/x/repos/REACT", true],
    ["react", "vue", false],
  ])("%s and %s: %s", (a, b, same) => {
    expect(sameIgnoringCase(a, b)).toBe(same);
  });
});

describe("settleDeadTemp", () => {
  const temp = (kind: "add" | "rename" | "removing", alias: string) => ({ kind, alias, pid: 1 });

  test("an add's folder is always trash: its entry is saved only once it is in place", () => {
    expect(settleDeadTemp(temp("add", "lib"), ["lib"])).toEqual({ _tag: "Trash" });
  });

  test.each([
    [
      "moves back when its alias is missing its folder",
      ["lib"],
      { _tag: "MoveBack", alias: "lib" },
    ],
    ["is trash when its alias has its folder", [], { _tag: "Trash" }],
    ["never takes another spelling", ["LIB"], { _tag: "Trash" }],
  ])("a remove's folder %s", (_label, missing, settled) => {
    expect(settleDeadTemp(temp("removing", "lib"), missing)).toEqual(settled);
  });

  test.each([
    ["takes the same spelling first", ["React", "REACT"], { _tag: "MoveBack", alias: "React" }],
    [
      "takes the one other spelling missing its folder",
      ["react"],
      { _tag: "MoveBack", alias: "react" },
    ],
    [
      "is kept when two other spellings are missing their folders",
      ["react", "REACT"],
      { _tag: "Keep" },
    ],
    ["is trash when no spelling is missing its folder", ["vue"], { _tag: "Trash" }],
  ])("a case-only rename's folder %s", (_label, missing, settled) => {
    expect(settleDeadTemp(temp("rename", "React"), missing)).toEqual(settled);
  });
});
