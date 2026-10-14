// Test setup file (run by vitest before every test file).
//
// Points the test process at a throwaway shelf home and an empty local stub
// for npm and GitHub, so no test can touch the real shelf home or the
// network, even one that builds the real service layers in-process. CLI
// tests get their own sandbox per test from tests/helpers/shelf-cli.ts.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vite-plus/test";
import { startStubServices } from "./helpers/stub-services";

const home = await mkdtemp(join(tmpdir(), "shelf-test-home-"));
const services = await startStubServices();

process.env["SHELF_HOME"] = home;
process.env["SHELF_NPM_REGISTRY_URL"] = services.npmUrl;
process.env["SHELF_GITHUB_API_URL"] = services.githubUrl;

afterAll(async () => {
	await services.stop();
	await rm(home, { recursive: true, force: true });
});
