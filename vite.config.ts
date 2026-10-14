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
	},
});
