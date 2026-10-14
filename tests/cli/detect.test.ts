import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";
import { writeText } from "../helpers/files";
import { createBareRepo } from "../helpers/temp-repo";

describe("detect command", () => {
  let tempDir: string;
  let shelf: ShelfSandbox;
  const runShelf = (args: string[]) => shelf.run(args);

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "shelf-detect-cli-"));
    shelf = await createShelfSandbox({
      npm: {
        "shelf-fixture-pkg": {
          repository: {
            type: "git",
            url: "git+https://example.test/fixtures/shelf-fixture-pkg.git",
          },
        },
      },
    });
  });

  afterEach(async () => {
    await shelf.cleanup();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("reports no repos when no dependency files exist", async () => {
    const result = await runShelf(["detect", "--dir", tempDir]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("No repos detected");
  });

  test("detects known repos from package.json", async () => {
    await writeText(
      join(tempDir, "package.json"),
      JSON.stringify({ dependencies: { react: "^18.2.0", zod: "^3.22.0" } }),
    );
    const result = await runShelf(["detect", "--dir", tempDir]);
    expect(result.exitCode).toBe(0);
    // Should mention react and zod regardless of shelved status
    expect(result.output).toContain("react");
    expect(result.output).toContain("zod");
  });

  test("detects repos from go.mod", async () => {
    await writeText(
      join(tempDir, "go.mod"),
      `module example.com/myapp

go 1.21

require (
	github.com/gin-gonic/gin v1.9.1
)`,
    );
    const result = await runShelf(["detect", "--dir", tempDir]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("gin");
  });

  test("handles empty directory gracefully", async () => {
    const result = await runShelf(["detect", "--dir", tempDir]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("No repos detected");
  });

  test("handles directory with invalid package.json", async () => {
    await writeText(join(tempDir, "package.json"), "not valid json");
    const result = await runShelf(["detect", "--dir", tempDir]);
    expect(result.exitCode).toBe(0);
    // Should not crash
  });

  test("looks up packages outside the built-in registry on npm", async () => {
    await writeText(
      join(tempDir, "package.json"),
      JSON.stringify({
        dependencies: { "shelf-fixture-pkg": "^4.18.0", "unknown-to-npm": "^1.0.0" },
      }),
    );
    const result = await runShelf(["detect", "--dir", tempDir]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("https://example.test/fixtures/shelf-fixture-pkg.git");
    expect(result.output).not.toContain("unknown-to-npm");
  });
});

describe("detect flags", () => {
  let project: string;
  let remote: string;
  let shelf: ShelfSandbox;

  beforeEach(async () => {
    // A bare repo whose path ends in .git, so the npm repository URL survives normalisation.
    const bare = await createBareRepo({ "index.ts": "export const fixture = 1;" });
    remote = `${bare.dir}.git`;
    await rename(bare.dir, remote);
    project = await mkdtemp(join(tmpdir(), "shelf-detect-flags-"));
    await writeText(
      join(project, "package.json"),
      JSON.stringify({ dependencies: { "shelf-detect-fixture": "^1.0.0" } }),
    );
    shelf = await createShelfSandbox({
      npm: { "shelf-detect-fixture": { repository: { type: "git", url: remote } } },
    });
  });

  afterEach(async () => {
    await shelf.cleanup();
    await rm(project, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  });

  test("with no flags scans the current directory and suggests --apply", async () => {
    const result = await shelf.run(["detect"], { cwd: project });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Detected 1 new repo(s):");
    expect(result.stdout).toMatch(/shelf-detect-fixture\s+\S*\.git/);
    expect(result.stdout).toContain("Run `shelf detect --apply` to add them.");
    const list = await shelf.run(["list"]);
    expect(list.stdout).not.toContain("shelf-detect-fixture");
  });

  test("--format shelffile prints only shelffile lines", async () => {
    const result = await shelf.run(["detect", "--format", "shelffile"], { cwd: project });
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^shelf-detect-fixture \S*\.git$/);
  });

  test("--format shelffile still lists a dependency that is already shelved", async () => {
    expect((await shelf.run(["detect", "--apply"], { cwd: project })).exitCode).toBe(0);

    const result = await shelf.run(["detect", "--format", "shelffile"], { cwd: project });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trimEnd().split("\n")).toEqual([
      expect.stringMatching(/^shelf-detect-fixture \S*\.git$/),
    ]);
  });

  test("--format shelffile prints nothing to stdout when nothing is detected", async () => {
    const empty = await mkdtemp(join(tmpdir(), "shelf-detect-empty-"));
    try {
      const result = await shelf.run(["detect", "--format", "shelffile"], { cwd: empty });

      expect(result.exitCode).toBe(0);
      // `detect --format shelffile > shelffile` must leave a shelffile that parses.
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("No repos detected");
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  test("--apply adds the detected repos, and a second run skips them", async () => {
    const result = await shelf.run(["detect", "--apply"], { cwd: project });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Added "shelf-detect-fixture"');
    expect(result.stdout).not.toContain("--apply");
    const list = await shelf.run(["list"]);
    expect(list.stdout).toContain("shelf-detect-fixture");

    const again = await shelf.run(["detect"], { cwd: project });
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("Already shelved (1):");
    expect(again.stdout).toMatch(/shelf-detect-fixture\s+\(skipped\)/);
    expect(again.stdout).not.toContain("Detected");
  });
});
