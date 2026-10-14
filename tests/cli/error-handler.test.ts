import { describe, test, expect } from "vite-plus/test";
import { formatUserError } from "../../src/cli/error-handler";

describe("formatUserError: known error tags", () => {
  test.each([
    [
      { _tag: "RepoNotFoundError", alias: "effect" },
      'Repo "effect" not found. Run `shelf list` to see available repos.',
    ],
    [{ _tag: "RepoAlreadyExistsError", alias: "effect" }, 'Repo "effect" already exists.'],
    [
      {
        _tag: "RepoRemoveError",
        alias: "lib",
        path: "/x/repos/lib",
        message: "EACCES: permission denied",
      },
      "Could not delete the repo folder /x/repos/lib: EACCES: permission denied. Its config entry was kept.",
    ],
    [
      { _tag: "InvalidAliasError", alias: "../x", message: "must not contain slashes" },
      'Invalid alias "../x": must not contain slashes.',
    ],
    [
      { _tag: "AliasRenameError", from: "old", to: "new", message: "target exists" },
      'Could not rename "old" to "new": target exists. Nothing was changed.',
    ],
    [{ _tag: "GitOperationError", message: "clone failed" }, "Git error: clone failed"],
    [
      { _tag: "SyncFailedError", failed: 2, total: 5 },
      "Sync failed: 2 of 5 repos could not be synced.",
    ],
    [
      { _tag: "AutoPinResolutionError", message: "no tags found" },
      "Auto-pin failed: no tags found",
    ],
    [{ _tag: "PinResolutionError", message: "unknown ref" }, "Pin failed: unknown ref"],
    [{ _tag: "ConfigParseError", message: "bad JSON" }, "Config error: bad JSON"],
    [
      {
        _tag: "ConfigParseError",
        reason: "invalid-json",
        message: "config.json is not valid JSON: Unexpected end of JSON input",
      },
      "config.json is not valid JSON: Unexpected end of JSON input",
    ],
    [{ _tag: "ConfigWriteError", message: "disk full" }, "Could not save shelf state: disk full"],
    [
      { _tag: "RepoFolderError", path: "/shelf/repos/x", message: "permission denied" },
      "Could not create the repo folder /shelf/repos/x: permission denied",
    ],
    [
      { _tag: "InvalidConfigValueError", message: "syncIntervalMinutes must be a number" },
      "syncIntervalMinutes must be a number",
    ],
    [
      { _tag: "UnknownConfigKeyError", key: "colour" },
      'Unknown config key "colour". Known keys: syncIntervalMinutes, version.',
    ],
    [
      { _tag: "InstallFailedError", failed: 1, total: 3 },
      "Install failed: 1 of 3 repos could not be added.",
    ],
    [
      { _tag: "ShelffileNotFoundError", path: "/project/shelffile" },
      "No shelffile found at /project/shelffile. Create one or use `shelf share` to generate one.",
    ],
    [{ _tag: "ShelffileParseError", message: "line 3" }, "Shelffile error: line 3"],
    [{ _tag: "RegistryParseError", message: "bad JSON" }, "Registry error: bad JSON"],
    [
      { _tag: "RegistryWriteError", message: "disk full" },
      "Could not save the registry: disk full",
    ],
    [
      { _tag: "ResolveError", input: "foobar", message: "Not found" },
      'Could not resolve "foobar": Not found',
    ],
    [
      { _tag: "DetectError", message: "No package.json found" },
      "Detection failed: No package.json found",
    ],
    [{ _tag: "DaemonAlreadyRunningError", pid: 12_345 }, "Daemon is already running (PID: 12345)."],
    [{ _tag: "DaemonNotRunningError" }, "No daemon is currently running."],
    [{ _tag: "DaemonStartError", message: "Spawn failed" }, "Failed to start daemon: Spawn failed"],
    [
      { _tag: "DaemonStillStoppingError", pid: 42 },
      "The daemon (PID: 42) is still finishing its current step; it stops once that step is done. Run `shelf daemon status` to check.",
    ],
    [
      { _tag: "UnknownAgentError", agent: "claud", known: ["claude", "opencode", "gemini"] },
      'Unknown agent "claud". Expected one of: claude, opencode, gemini',
    ],
    [
      {
        _tag: "SkillWriteError",
        path: "/project/.agents/skills/shelf/SKILL.md",
        message: "permission denied",
      },
      "Could not write the skill file /project/.agents/skills/shelf/SKILL.md: permission denied",
    ],
  ])("formats $_tag", (error, expected) => {
    expect(formatUserError(error)).toBe(expected);
  });

  test("formats an UnknownAgentError that lost its known-agent list without throwing", () => {
    expect(formatUserError({ _tag: "UnknownAgentError", agent: "claud" })).toBe(
      'Unknown agent "claud". Expected one of: ',
    );
  });

  test("formats a real Error subclass carrying a _tag", () => {
    const error = Object.assign(new Error("clone failed"), { _tag: "GitOperationError" });
    expect(formatUserError(error)).toBe("Git error: clone failed");
  });
});

describe("formatUserError: anything else returns null", () => {
  test.each([
    ["an unknown tag", { _tag: "SomeRandomError" }],
    ["the removed ConfigNotFoundError tag", { _tag: "ConfigNotFoundError", path: "/x" }],
    ["a tag named after an Object.prototype method", { _tag: "toString" }],
    ["a tag named after Object.prototype.constructor", { _tag: "constructor" }],
    ["a plain Error", new Error("plain error")],
    ["an object without _tag", { message: "no tag" }],
    ["null", null],
    ["undefined", undefined],
    ["a string", "some error"],
    ["a number", 42],
  ])("%s", (_label, error) => {
    expect(formatUserError(error)).toBeNull();
  });
});
