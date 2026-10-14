// Global setup (run by vitest once per test run, before any test file).
//
// Builds the CLI into dist with `vp pack`, so CLI tests run the built binary
// under node, the same artifact that ships, and the build happens once per run.

import { execFileSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

export default function setup(): void {
	execFileSync(join(root, "node_modules/.bin/vp"), ["pack"], { cwd: root, stdio: "inherit" });
}
