import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";
import { createBareRepo } from "../helpers/temp-repo";
import { readJson } from "../helpers/files";

let shelf: ShelfSandbox;

beforeEach(async () => {
  shelf = await createShelfSandbox();
});

afterEach(async () => {
  await shelf.cleanup();
});

describe("shelf config", () => {
  test("with no arguments prints the default config as JSON", async () => {
    const result = await shelf.run(["config"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ version: 1, syncIntervalMinutes: 60, repos: [] });
  });

  test("with no arguments prints repos as they are stored in config.json", async () => {
    const repo = await createBareRepo();
    try {
      const add = await shelf.run(["add", repo.dir, "--alias", "lib"]);
      expect(add.exitCode).toBe(0);

      const result = await shelf.run(["config"]);
      expect(result.exitCode).toBe(0);
      const printed = JSON.parse(result.stdout) as { repos: Array<Record<string, unknown>> };
      expect(printed).toEqual(await readJson(join(shelf.home, "config.json")));
      expect(printed.repos[0]).toMatchObject({ alias: "lib", url: repo.dir });
      expect(result.stdout).not.toContain('"_tag"');
    } finally {
      await repo.cleanup();
    }
  });

  test("reports a config.json with a JSON syntax error as not valid JSON, not a read failure", async () => {
    await writeFile(join(shelf.home, "config.json"), "{not json");
    const result = await shelf.run(["config"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/config\.json is not valid JSON: \S/);
    expect(result.stderr).not.toContain("Failed to read config file");
  });

  test("with the version key prints the config version", async () => {
    const result = await shelf.run(["config", "version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("1");
  });
});

describe("shelf config syncIntervalMinutes", () => {
  test("sets a whole number of 1 or more", async () => {
    const set = await shelf.run(["config", "syncIntervalMinutes", "15"]);
    expect(set.exitCode).toBe(0);
    const get = await shelf.run(["config", "syncIntervalMinutes"]);
    expect(get.stdout.trim()).toBe("15");
  });

  test.each(["0", "-1", "1.5", "abc"])("rejects %j and keeps the old value", async (value) => {
    const set = await shelf.run(["config", "syncIntervalMinutes", "--", value]);
    expect(set.exitCode).toBe(1);
    expect(set.stderr).toContain("syncIntervalMinutes must be a whole number of 1 or more");
    const get = await shelf.run(["config", "syncIntervalMinutes"]);
    expect(get.stdout.trim()).toBe("60");
  });
});

describe("shelf config version <value>", () => {
  test("fails with exit 1, says version is read-only, and keeps it", async () => {
    const result = await shelf.run(["config", "version", "2"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("version is read-only");
    expect(result.stderr).not.toContain("Unknown config key");
    expect((await shelf.run(["config", "version"])).stdout.trim()).toBe("1");
  });
});

describe("shelf config <unknown key>", () => {
  test.each([[["config", "nope"]], [["config", "nope", "5"]]])(
    "%j fails with exit 1 and names the key",
    async (args) => {
      const result = await shelf.run(args);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Unknown config key "nope"');
    },
  );
});
