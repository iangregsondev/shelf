import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  pack: {
    // The CLI and the daemon process it launches; both land in dist side by side.
    entry: { index: "src/startup/index.ts", daemon: "src/startup/daemon.ts" },
    outDir: "dist",
    format: "esm",
    platform: "node",
    dts: false,
  },
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    globalSetup: ["./tests/global-setup.ts"],
    // CLI tests spawn the built CLI under node and run real git, often a dozen
    // processes per test, and vitest runs test files in parallel on every core.
    // Under that load a test that takes 1-2s alone can pass vitest's 5s default
    // (bun test ran files one at a time, so 5s was enough there).
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // CLI tests run the built dist/index.mjs in child processes, and v8
      // coverage only sees code loaded in the test process itself. The command
      // files, the two startup entrypoints and the layer composition under
      // src/startup/ only ever run there, so they would always read as 0%.
      // Their behaviour is covered by the CLI tests in tests/cli/ instead.
      exclude: ["src/cli/commands/**", "src/startup/**"],
      // The text report lists only files below 100%, so a run names the files
      // that need tests. The html report in coverage/ lists every file.
      reporter: [["text", { skipFull: true }], "html"],
    },
  },
});
