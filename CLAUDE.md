# CLAUDE.md

## What is Shelf?

Shelf is a standalone CLI that maintains a global, always-up-to-date cache of code reference repositories that AI agents can read directly using their native tools. It handles repo lifecycle management: clone, pin, sync, remove.

## Commands

- `bun run src/startup/index.ts` — run shelf CLI
- `bun run test` — run all tests. They run offline, in temp shelf homes, and never touch `~/.agents/shelf`
- `bun run test --coverage` — run with coverage
- `bun run check` — format check, lint and typecheck
- `bunx --bun tsc --noEmit` — typecheck only

## Architecture

Domain-Sliced Architecture. Each domain has flat, suffix-based files.

```
src/domain/{domain-name}/{name}-service.ts  — business logic
src/domain/{domain-name}/{name}-schema.ts   — schemas
src/domain/{domain-name}/{name}-errors.ts   — typed errors
src/domain/{domain-name}/{name}-utils.ts    — pure functions
src/domain/{domain-name}/{name}-store.ts    — storage boundary: file-system I/O
src/cli/commands/{name}.ts                  — CLI entrypoints
src/startup/index.ts                        — CLI entrypoint
src/startup/layers/app.ts                   — layer composition
```

Domains: `config`, `daemon`, `detect`, `git`, `registry`, `repo`, `resolve`, `shelffile`, `sync`.

Dependency direction: `command → service → storage boundary`. Reverse imports forbidden.

## Effect-TS v4 Patterns (effect 4.0.4)

- Services use `Context.Service<Self>()("tag", { make })` (`import * as Context from "effect/Context"`) with `static layer`
- Methods use `Effect.fn("ClassName.methodName")(function* (args) { ... })`
- Zero-arg methods still need `()` to call: `service.method()`
- Errors use `Schema.TaggedError<Self>()("Tag", { fields })`; an error's `name` equals its tag
- `Schema.Literal` accepts a single value; for unions use `Schema.Union([Schema.Literal("a"), Schema.Literal("b")])` or `Schema.Literals(["a", "b"])`
- Optional fields decoded to `Option`: use `Schema.OptionFromOptionalKey(schema)`
- `Effect.catch` replaces v3's `Effect.catchAll`
- `Effect.catchTag` still works for tagged error handling
- Import CLI from `effect/cli` (`Command`, `Flag`, `Argument`); constructors are PascalCase: `Flag.String`, `Flag.Boolean`, `Flag.Int`, `Argument.String`
- Import BunRuntime from `@effect/platform-bun/BunRuntime`
- Versions are pinned exactly and `bun.lock` is committed; bump `effect` and `@effect/platform-bun` together

## Testing

- `tests/setup.ts` (preloaded for every run) sets `SHELF_HOME` to a temp dir and points `SHELF_NPM_REGISTRY_URL` and `SHELF_GITHUB_API_URL` at an empty local stub, so no test reaches the real shelf home or the network
- CLI tests run the real `shelf` binary through `createShelfSandbox()` in `tests/helpers/shelf-cli.ts`: a fresh temp shelf home per test, plus stub npm and GitHub responses (`tests/helpers/stub-services.ts`). Call `cleanup()` in `afterEach`
- A test that starts a daemon must stop it in `afterEach` with `stopDaemonIn()` from `tests/helpers/daemon.ts`, so it is stopped even when the test fails
- Tests mirror source in `tests/domain/{domain}/`
- Each domain has `helpers.ts` with mock layers via `Layer.succeed(Service, Service.of(impl))`
- Use `Effect.runPromise` / `Effect.runPromiseExit` for test assertions

## Storage

All shelf state lives in the shelf home: `$SHELF_HOME` if set (a relative path resolves against the working directory), otherwise `~/.agents/shelf`. `ConfigService` resolves it once (`resolveShelfHome` in `config-utils.ts`); everything else takes paths from `ConfigService`, never from `homedir()`.

- Config: `<shelf home>/config.json`
- Registry: `<shelf home>/registry.json`
- Repos: `<shelf home>/repos/{alias}/`
- Daemon state and log: `<shelf home>/daemon.json`, `<shelf home>/daemon.log`
- Shelffile: `./shelffile` (per-project)

External services: the npm registry and GitHub API base URLs read `SHELF_NPM_REGISTRY_URL` and `SHELF_GITHUB_API_URL`, falling back to `https://registry.npmjs.org` and `https://api.github.com`.

## Agent skills

### Issue tracker

GitHub Issues on `iangregsondev/shelf`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
