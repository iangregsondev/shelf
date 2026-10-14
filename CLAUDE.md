# CLAUDE.md

## What is Shelf?

Shelf is a standalone CLI that maintains a global, always-up-to-date cache of code reference repositories that AI agents can read directly using their native tools. It handles repo lifecycle management: clone, pin, sync, remove.

## Commands

- `bun run src/startup/index.ts` — run shelf CLI
- `bun run test` — run all tests with `HOME` pointed at a fresh temp dir. Never run bare `bun test`: until the shelf home override lands, tests write to the real `~/.agents/shelf`
- `HOME=$(mktemp -d) bun test --coverage` — run with coverage
- `bun run check` — format check, lint and typecheck
- `bunx --bun tsc --noEmit` — typecheck only

## Architecture

Domain-Sliced Architecture. Each domain has flat, suffix-based files.

```
src/domain/{domain-name}/{name}-service.ts  — business logic
src/domain/{domain-name}/{name}-schema.ts   — schemas
src/domain/{domain-name}/{name}-errors.ts   — typed errors
src/domain/{domain-name}/{name}-utils.ts    — pure functions
src/cli/commands/{name}.ts                  — CLI entrypoints
src/startup/index.ts                        — CLI entrypoint
src/startup/layers/app.ts                   — layer composition
```

Domains: `config`, `git`, `sync`, `repo`, `shelffile`, `registry`.

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

- Tests mirror source in `tests/domain/{domain}/`
- Each domain has `helpers.ts` with mock layers via `Layer.succeed(Service, Service.of(impl))`
- Use `Effect.runPromise` / `Effect.runPromiseExit` for test assertions

## Storage

- Config: `~/.agents/shelf/config.json`
- Registry: `~/.agents/shelf/registry.json`
- Repos: `~/.agents/shelf/repos/{alias}/`
- Shelffile: `./shelffile` (per-project)

## Agent skills

### Issue tracker

GitHub Issues on `iangregsondev/shelf`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
