// `shelf info <alias>`: a known alias and an unknown one.

import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";
import { createRemote, type Remote } from "../helpers/git-remote";
import { writeText } from "../helpers/files";

let shelf: ShelfSandbox;
let tempDir: string;
let remote: Remote;

beforeEach(async () => {
  shelf = await createShelfSandbox();
  tempDir = await mkdtemp(join(tmpdir(), "shelf-info-test-"));
  remote = await createRemote(tempDir);
});

afterEach(async () => {
  await shelf.cleanup();
  await rm(tempDir, { recursive: true, force: true });
});

describe("shelf info", () => {
  test("a known alias shows its url, pin, sync time, size, path, references and contents", async () => {
    expect(
      (await shelf.run(["add", remote.url, "--alias", "lib", "--pin", "tag:v1"])).exitCode,
    ).toBe(0);

    const result = await shelf.run(["info", "lib"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Alias:       lib\n");
    expect(result.stdout).toContain(`URL:         ${remote.url}\n`);
    expect(result.stdout).toContain("Pin:         tag:v1\n");
    expect(result.stdout).toMatch(/Added: {7}\d{4}-\d\d-\d\dT/);
    expect(result.stdout).toMatch(/Last synced: \d{4}-\d\d-\d\dT/);
    expect(result.stdout).toMatch(/Disk size: {3}\d+\.\d MB/);
    expect(result.stdout).toContain(`Path:        ${join(shelf.home, "repos", "lib")}\n`);
    expect(result.stdout).toContain("Referenced:  manual\n");
    // Hidden entries such as .git are left out of the listing.
    expect(result.stdout).toMatch(/\nContents:\n {2}file\.txt\n$/);
  });

  test("leaves out the Contents heading when the folder holds only hidden entries", async () => {
    expect((await shelf.run(["add", remote.url, "--alias", "lib"])).exitCode).toBe(0);
    // Only .git is left.
    await rm(join(shelf.home, "repos", "lib", "file.txt"));

    const result = await shelf.run(["info", "lib"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("Contents:");
  });

  test("an unknown alias fails with a clear error and exit 1", async () => {
    const result = await shelf.run(["info", "missing"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      'Repo "missing" not found. Run `shelf list` to see available repos.',
    );
  });

  test("lists the projects whose shelffile uses the repo", async () => {
    const project = join(tempDir, "project");
    await writeText(join(project, "shelffile"), `lib ${remote.url}\n`);
    expect((await shelf.run(["install", "--dir", project])).exitCode).toBe(0);

    const result = await shelf.run(["info", "lib"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Referenced:  ${project}\n`);
  });

  test("a relative registry entry is not read against the working directory", async () => {
    expect((await shelf.run(["add", remote.url, "--alias", "lib"])).exitCode).toBe(0);
    // An older shelf recorded projects as relative paths.
    await writeText(
      join(shelf.home, "registry.json"),
      JSON.stringify({ projects: ["proj"], manual: [] }),
    );
    const cwd = join(tempDir, "cwd");
    await writeText(join(cwd, "proj", "shelffile"), `lib ${remote.url}\n`);

    const result = await shelf.run(["info", "lib"], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('Warning: Registry entry "proj" is a relative path');
    expect(result.stdout).not.toContain("Referenced:  proj");
    expect(result.stdout).not.toContain("candidate for `shelf prune`");
    expect(result.stdout).toContain("Referenced:  unknown (see the warnings above)\n");
  });

  test("still names a project whose shelffile no longer parses, with a warning", async () => {
    const project = join(tempDir, "project");
    await writeText(join(project, "shelffile"), `lib ${remote.url}\n`);
    expect((await shelf.run(["install", "--dir", project])).exitCode).toBe(0);
    await writeText(join(project, "shelffile"), `lib ${remote.url}\njunk\n`);

    const result = await shelf.run(["info", "lib"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(`Warning: Can't parse ${join(project, "shelffile")}`);
    expect(result.stdout).toContain(`Referenced:  ${project}\n`);
  });
});
