import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createBareRepo } from "../helpers/temp-repo";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";

describe("add resolves the URL forms users paste", () => {
  let shelf: ShelfSandbox;
  let repo: { dir: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    repo = await createBareRepo({ "found.ts": "export {};" });
    shelf = await createShelfSandbox({
      github: { toString: [{ clone_url: repo.dir, name: "toString" }] },
    });
  });

  afterEach(async () => {
    await shelf.cleanup();
    await repo.cleanup();
  });

  test("a file:// URL is cloned, not searched for as a package name", async () => {
    const result = await shelf.run(["add", `file://${repo.dir}`, "--alias", "via-file-url"]);
    expect(result.output).not.toContain("Resolved");
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(shelf.home, "repos", "via-file-url", "found.ts"))).toBe(true);
  });

  test("a prototype name like toString is searched for as a package", async () => {
    const result = await shelf.run(["add", "toString"]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(shelf.home, "repos", "toString", "found.ts"))).toBe(true);
  });

  test("an unparsable URL gives a clear error and exits 1", async () => {
    const result = await shelf.run(["add", "https://"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Could not resolve "https://": "https://" is not a valid URL');
    expect(result.output).not.toContain("at <anonymous>");
    expect(result.output).not.toContain("TypeError");
    expect(existsSync(join(shelf.home, "repos", "https:"))).toBe(false);
  });
});
