// Runs the real `shelf` CLI as a subprocess inside a sandbox: a fresh temp
// shelf home and a local stub for npm and GitHub. Every CLI test goes through
// this, so no test touches the real shelf home or the network.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopDaemonIn } from "./daemon";
import { run as runProcess } from "./process";
import { startStubServices, type StubResponses } from "./stub-services";

/** The built CLI (from `vp pack`, run once per test run by tests/global-setup.ts). */
const CLI = join(import.meta.dirname, "../../dist/index.mjs");

export interface ShelfResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly output: string;
}

export interface ShelfSandbox {
  /** The temp shelf home this sandbox's CLI runs use. */
  readonly home: string;
  /** The environment every CLI run gets. */
  readonly env: Readonly<Record<string, string>>;
  readonly run: (
    args: ReadonlyArray<string>,
    options?: { cwd?: string | undefined },
  ) => Promise<ShelfResult>;
  /** Stops any daemon in the shelf home, stops the stub server and deletes the shelf home. */
  readonly cleanup: () => Promise<void>;
}

/** The built CLI, for tests that spawn it themselves under node (say, in the background). */
export const SHELF_CLI = CLI;

export const createShelfSandbox = async (
  stubs: StubResponses = {},
  /** Extra environment for every CLI run (and any daemon it starts), such as a PATH with shims. */
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<ShelfSandbox> => {
  const home = await mkdtemp(join(tmpdir(), "shelf-home-"));
  const services = await startStubServices(stubs);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    SHELF_HOME: home,
    SHELF_NPM_REGISTRY_URL: services.npmUrl,
    SHELF_GITHUB_API_URL: services.githubUrl,
    ...extraEnv,
  };

  const run = async (
    args: ReadonlyArray<string>,
    options: { cwd?: string | undefined } = {},
  ): Promise<ShelfResult> => {
    const { exitCode, stdout, stderr } = await runProcess([process.execPath, CLI, ...args], {
      cwd: options.cwd ?? process.cwd(),
      env,
    });
    return { stdout, stderr, exitCode, output: stdout + stderr };
  };

  const cleanup = async (): Promise<void> => {
    try {
      await stopDaemonIn(home);
    } finally {
      await services.stop();
      await rm(home, { recursive: true, force: true });
    }
  };

  return { home, env, run, cleanup };
};
