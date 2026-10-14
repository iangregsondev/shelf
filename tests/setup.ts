// Global test setup (preloaded by bunfig.toml for every `bun test` run).
//
// Points the test process at a throwaway shelf home and an empty local stub
// for npm and GitHub, so no test can touch the real shelf home or the
// network, even one that builds the real service layers in-process. CLI
// tests get their own sandbox per test from tests/helpers/shelf-cli.ts.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStubServices } from "./helpers/stub-services";

const home = mkdtempSync(join(tmpdir(), "shelf-test-home-"));
const services = startStubServices();

process.env["SHELF_HOME"] = home;
process.env["SHELF_NPM_REGISTRY_URL"] = services.npmUrl;
process.env["SHELF_GITHUB_API_URL"] = services.githubUrl;

process.on("exit", () => {
	rmSync(home, { recursive: true, force: true });
});
