# Run shelf on Node.js with vite-plus, not Bun

Status: accepted (October 2026, #19)

## Context

Shelf started on Bun. Users had to install Bun to install or run the CLI, because the published package shipped raw TypeScript that only Bun could execute. The source and tests called Bun-only APIs (`Bun.file`, `Bun.write`, `Bun.spawn`, `Bun.serve`, `Bun.YAML`) and `@effect/platform-bun`. Contributors worked with a hand-assembled toolchain: `bun test` with a preload, standalone oxlint and oxfmt with large custom configs pinned to old versions, and a separate typecheck.

## Decision

### Move to Node.js 24

Shelf runs on Node.js 24, the runtime almost every developer machine already has. Anyone can install it with npm, pnpm or yarn, and nobody needs Bun. Source I/O goes through Effect's own platform services (`FileSystem`, `ChildProcessSpawner`) with `@effect/platform-node` at the entrypoints, so the code stays idiomatic Effect and testable through layers, and is no longer tied to one runtime's APIs.

The toolchain is vite-plus (`vp`): `vp install` (pnpm), `vp check` (format, type-aware lint, typecheck), `vp test` (vitest) and `vp pack` (tsdown). One tool replaces the separately pinned pieces.

### Build the CLI to `dist`

`vp pack` bundles the CLI and the daemon entrypoint into `dist/`, and the package ships only `dist`, with a `#!/usr/bin/env node` bin.

We cannot ship the `.ts` sources and let Node run them. Node's built-in type stripping refuses files inside `node_modules`, so a globally installed package whose bin is a `.ts` file fails to start. Building is the only way the published CLI runs under plain `node`. CLI tests run the same built `dist` (vitest's global setup builds it once per run), so the tests cover what ships.

### Take vite-plus default lint and format settings

We use vite-plus's default format and lint settings, with type-aware lint and typecheck turned on, instead of porting the old strict custom oxlint rule set and the old oxfmt style (tabs, width 100).

The old config was hundreds of hand-picked rules to maintain and keep in step with new oxlint releases, and much of it was style preference rather than bug-catching. The defaults track vite-plus upgrades for free, and type-aware lint still catches what matters most (type errors, floating and misused promises). The one-off reformat lands in its own commit listed in `.git-blame-ignore-revs`, so `git blame` still points at real changes.

## Consequences

- Bun is no longer supported, and is not kept alongside Node.
- Every run of the CLI from source needs a build first; `vp test` does it automatically.
- `devEngines` pins pnpm, so `npm publish` and `npm pack` refuse to run (EBADDEVENGINES). Publishing goes through `vp pm publish`, which forwards to pnpm.
- Lint is looser than before on style; reviewers no longer get those checks from the linter.
