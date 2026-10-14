<div align="center">

  <h1>shelf</h1>
  <p><em>A global cache of code reference repositories for AI agents</em></p>

</div>

## Install

```bash
npm install -g @iangregsondev/shelf
```

Shelf needs Node.js 24 or later. pnpm (`pnpm add -g`) and yarn work too.

## Quick Start

```bash
# Setup agent + auto-detect project repos
shelf init
shelf init --agent claude

# Add repos by name, owner/repo, or URL
shelf add react
shelf add Effect-TS/effect
shelf add https://github.com/vercel/next.js.git --pin tag:v15.0.0

# Or use a shelffile for your project
shelf install

# Detect repos from package.json / go.mod
shelf detect
shelf detect --apply

# Keep repos fresh in the background
shelf daemon start
```

Agents read repos directly at `~/.agents/shelf/repos/{alias}/` using their native tools.

All shelf state lives in the shelf home, `~/.agents/shelf` by default. Set `SHELF_HOME` to use a different directory.

## How It Works

```
┌──────────────┐       ┌──────────────┐       ┌──────────────────────────┐
│  shelf add   │──────▶│  Git Clone   │──────▶│ ~/.agents/shelf/repos/   │
│  shelffile   │       │  (shallow)   │       │   effect/                │
│  + install   │       │              │       │   react/                 │
└──────────────┘       └──────────────┘       │   ...                    │
                                              └────────────┬─────────────┘
                                                           │
                                              ┌────────────▼─────────────┐
                                              │  Agent reads directly    │
                                              │  Grep, Read, Glob, ls   │
                                              └──────────────────────────┘
```

Shelf manages the lifecycle — clone, pin, sync, remove. Your agent uses its own tools to explore the code. Clones are shallow by default (`--depth 1`, `--single-branch`) since repos are for code reference, not building.

## Docs

- [Commands](docs/commands.md) — full command reference
- [Shelffile](docs/shelffile.md) — per-project repo manifests and garbage collection
- [Agent Integration](docs/agent-integration.md) — setting up skill files for your agent

## Development

Shelf uses [Vite+](https://viteplus.dev) (`vp`) for its toolchain: pnpm, Node.js 24, vitest, oxlint, oxfmt and tsdown.

```bash
vp install               # install dependencies
vp check                 # format check, type-aware lint and typecheck
vp test                  # run tests (offline, in temp shelf homes)
vp pack                  # build the CLI into dist
node dist/index.mjs      # run the built CLI
```

## Credits

Shelf was created by Dallen Pyrah at Rika Labs; this fork builds on the [original repository](https://github.com/Rika-Labs/shelf).

## License

MIT. See [LICENSE](LICENSE).
