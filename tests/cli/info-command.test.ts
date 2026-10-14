// `shelf info <alias>`: a known alias and an unknown one.

import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";
import { createRemote, type Remote } from "../helpers/git-remote";

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
});
