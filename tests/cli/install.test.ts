import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBareRepo } from "../helpers/temp-repo";
import { writeText } from "../helpers/files";
import { git } from "../helpers/process";

const uniqueAlias = (prefix: string): string =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let shelf: ShelfSandbox;
const runShelf = (args: string[], cwd?: string) => shelf.run(args, { cwd });

beforeEach(async () => {
  shelf = await createShelfSandbox();
});

afterEach(async () => {
  await shelf.cleanup();
});

describe("install command", () => {
  let tempDir: string;
  const aliases: string[] = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "shelf-install-test-"));
  });

  afterEach(async () => {
    aliases.length = 0;
    await rm(tempDir, { recursive: true, force: true });
  });

  test("installs single repo from shelffile", async () => {
    const alias = uniqueAlias("install");
    aliases.push(alias);

    const repo = await createBareRepo({ "lib.ts": "export const a = 1;" });
    await writeText(join(tempDir, "shelffile"), `${alias} ${repo.dir}\n`);

    const result = await runShelf(["install", "--dir", tempDir]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Install complete");
    expect(result.output).toContain("1 added");
    expect(result.output).toContain(`Added "${alias}"`);

    await repo.cleanup();
  });

  test("installs multiple repos from shelffile", async () => {
    const alias1 = uniqueAlias("multi1");
    const alias2 = uniqueAlias("multi2");
    aliases.push(alias1, alias2);

    const repo1 = await createBareRepo({ "lib1.ts": "export const a = 1;" });
    const repo2 = await createBareRepo({ "lib2.ts": "export const b = 2;" });

    await writeText(join(tempDir, "shelffile"), `${alias1} ${repo1.dir}\n${alias2} ${repo2.dir}\n`);

    const result = await runShelf(["install", "--dir", tempDir]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Install complete");
    expect(result.output).toContain("2 added");

    await repo1.cleanup();
    await repo2.cleanup();
  });

  test("reports already-present repos on re-install", async () => {
    const alias = uniqueAlias("reinstall");
    aliases.push(alias);

    const repo = await createBareRepo({ "lib.ts": "export {};" });
    await writeText(join(tempDir, "shelffile"), `${alias} ${repo.dir}\n`);

    await runShelf(["install", "--dir", tempDir]);
    const result = await runShelf(["install", "--dir", tempDir]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("1 already present");
    expect(result.stderr).not.toContain("Warning");

    await repo.cleanup();
  });

  test("warns and keeps the stored repo when an existing alias has a different URL", async () => {
    const alias = uniqueAlias("url-drift");
    const stored = await createBareRepo({ "lib.ts": "export {};" });
    const other = await createBareRepo({ "other.ts": "export {};" });
    await writeText(join(tempDir, "shelffile"), `${alias} ${stored.dir}\n`);
    await runShelf(["install", "--dir", tempDir]);

    await writeText(join(tempDir, "shelffile"), `${alias} ${other.dir}\n`);
    const result = await runShelf(["install", "--dir", tempDir]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(`Warning: "${alias}"`);
    expect(result.stderr).toContain(stored.dir);
    expect(result.stderr).toContain(other.dir);
    expect(result.output).toContain("1 already present");
    const info = await runShelf(["info", alias]);
    expect(info.stdout).toContain(stored.dir);
    expect(info.stdout).not.toContain(other.dir);

    await stored.cleanup();
    await other.cleanup();
  });

  test("warns and keeps the stored pin when an existing alias has a different pin", async () => {
    const alias = uniqueAlias("pin-drift");
    const repo = await createBareRepo({ "lib.ts": "export {};" });
    await writeText(join(tempDir, "shelffile"), `${alias} ${repo.dir}\n`);
    await runShelf(["install", "--dir", tempDir]);

    await writeText(join(tempDir, "shelffile"), `${alias} ${repo.dir} pin:branch:release\n`);
    const result = await runShelf(["install", "--dir", tempDir]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(`Warning: "${alias}"`);
    expect(result.stderr).toContain("(default branch)");
    expect(result.stderr).toContain("branch:release");
    const info = await runShelf(["info", alias]);
    expect(info.stdout).not.toContain("branch:release");

    await repo.cleanup();
  });

  test("stays silent when the stored entry matches in another form", async () => {
    const alias = uniqueAlias("same");
    const repo = await createBareRepo({ "lib.ts": "export {};" });
    const hash = await git(["rev-parse", "HEAD"], repo.dir);
    await writeText(
      join(tempDir, "shelffile"),
      `${alias} ${repo.dir} pin:commit:${hash.slice(0, 7)}\n`,
    );
    const first = await runShelf(["install", "--dir", tempDir]);
    expect(first.output).toContain(`Added "${alias}"`);

    // The stored pin is the full hash; the shelffile still has the short one.
    const again = await runShelf(["install", "--dir", tempDir]);
    expect(again.exitCode).toBe(0);
    expect(again.stderr).not.toContain("Warning");

    // A trailing .git is the same URL.
    await writeText(join(tempDir, "shelffile"), `${alias} ${repo.dir}.git pin:${hash}\n`);
    const normalized = await runShelf(["install", "--dir", tempDir]);
    expect(normalized.exitCode).toBe(0);
    expect(normalized.stderr).not.toContain("Warning");

    await repo.cleanup();
  });

  test("exits 1 and names the failure when an entry can't be installed", async () => {
    const good = uniqueAlias("good");
    const bad = uniqueAlias("bad");
    const repo = await createBareRepo({ "lib.ts": "export const a = 1;" });
    await writeText(
      join(tempDir, "shelffile"),
      `${good} ${repo.dir}\n${bad} ${join(tempDir, "no-such-remote.git")}\n`,
    );

    const result = await runShelf(["install", "--dir", tempDir]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`failed to add "${bad}"`);
    expect(result.output).toContain("1 added");
    expect(result.output).toContain("1 failed");
    expect(result.stderr).toContain("Install failed: 1 of 2 repos could not be added.");

    await repo.cleanup();
  });

  test("fails with exit 1 when the shelffile is missing", async () => {
    const result = await runShelf(["install", "--dir", tempDir]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No shelffile found");
  });

  test("with no flags installs from the shelffile in the current directory", async () => {
    const alias = uniqueAlias("cwd");
    const repo = await createBareRepo({ "lib.ts": "export {};" });
    await writeText(join(tempDir, "shelffile"), `${alias} ${repo.dir}\n`);

    const result = await runShelf(["install"], tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("concurrency: 4");
    expect(result.output).toContain(`Added "${alias}"`);
    const list = await runShelf(["list"]);
    expect(list.stdout).toContain(alias);

    await repo.cleanup();
  });

  test("accepts --concurrency flag", async () => {
    const alias = uniqueAlias("conc");
    aliases.push(alias);

    const repo = await createBareRepo({ "lib.ts": "export {};" });
    await writeText(join(tempDir, "shelffile"), `${alias} ${repo.dir}\n`);

    const result = await runShelf(["install", "--dir", tempDir, "--concurrency", "2"]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("concurrency: 2");

    await repo.cleanup();
  });
});
