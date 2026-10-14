import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShelfSandbox, type ShelfSandbox } from "../helpers/shelf-cli";

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
		await Bun.write(
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
		await Bun.write(
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
		await Bun.write(join(tempDir, "package.json"), "not valid json");
		const result = await runShelf(["detect", "--dir", tempDir]);
		expect(result.exitCode).toBe(0);
		// Should not crash
	});

	test("looks up packages outside the built-in registry on npm", async () => {
		await Bun.write(
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
