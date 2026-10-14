import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBareRepo } from "../helpers/temp-repo";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";
import { readJson, writeText } from "../helpers/files";
import { run } from "../helpers/process";

// A monorepo tags each package separately. Auto-pin must pick the tag for the
// package the user named, not one derived from the repo's URL.
describe("add --pin auto", () => {
	let shelf: ShelfSandbox;
	let monorepo: { dir: string; cleanup: () => Promise<void> };
	let project: string;

	const tag = async (name: string) => {
		const result = await run(["git", "tag", name, "HEAD"], { cwd: monorepo.dir });
		expect(result.exitCode).toBe(0);
	};

	const savedPin = async (alias: string) => {
		const config = (await readJson(join(shelf.home, "config.json"))) as {
			repos: Array<{ alias: string; pin?: { type: string; value: string } }>;
		};
		return config.repos.find((r) => r.alias === alias)?.pin;
	};

	beforeEach(async () => {
		// Name the repo after one of its packages, as monorepos often are.
		const bare = await createBareRepo({ "README.md": "# fixture monorepo" });
		const parent = await mkdtemp(join(tmpdir(), "shelf-autopin-remote-"));
		const dir = join(parent, "fixturelib.git");
		await rename(bare.dir, dir);
		monorepo = { dir, cleanup: () => rm(parent, { recursive: true, force: true }) };
		await tag("fixturelib@3.10.2");
		await tag("@fixture/widget@0.69.2");
		await tag("v0.69.2");
		shelf = await createShelfSandbox({
			github: {
				"@fixture/widget": [{ clone_url: monorepo.dir, name: "fixturelib" }],
			},
		});
		project = await mkdtemp(join(tmpdir(), "shelf-autopin-project-"));
		await writeText(
			join(project, "package.json"),
			JSON.stringify({
				dependencies: { "@fixture/widget": "^0.69.2", fixturelib: "^3.10.2" },
			}),
		);
	});

	afterEach(async () => {
		await shelf.cleanup();
		await monorepo.cleanup();
		await rm(project, { recursive: true, force: true });
	});

	test("pins a scoped package to its own tag", async () => {
		const result = await shelf.run(
			["add", "@fixture/widget", "--pin", "auto", "--alias", "widget"],
			{ cwd: project },
		);
		expect(result.exitCode).toBe(0);
		expect(await savedPin("widget")).toEqual({ type: "tag", value: "@fixture/widget@0.69.2" });
	});

	test("pins a direct URL by the repo's name", async () => {
		const result = await shelf.run(["add", monorepo.dir, "--pin", "auto", "--alias", "lib"], {
			cwd: project,
		});
		expect(result.exitCode).toBe(0);
		expect(await savedPin("lib")).toEqual({ type: "tag", value: "fixturelib@3.10.2" });
	});
});
