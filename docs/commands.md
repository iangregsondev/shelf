# Commands

## Core

| Command                                                                    | Purpose                     |
| -------------------------------------------------------------------------- | --------------------------- |
| `shelf add <repo> [--alias name] [--pin ref] [--depth N] [--sparse paths]` | Add a reference repo        |
| `shelf remove <alias>`                                                     | Remove a repo               |
| `shelf list`                                                               | Show repos with local paths |
| `shelf update [alias]`                                                     | Sync one or all repos       |

### Shorthand resolution

`shelf add` accepts multiple input formats — you don't need the full git URL:

```bash
shelf add react                        # bare name → built-in registry (~90 popular repos)
shelf add Effect-TS/effect             # owner/repo → github.com
shelf add github:vercel/next.js        # prefixed → github.com (also gitlab:, bitbucket:)
shelf add https://github.com/org/repo  # full URL → used directly
shelf add ./local-repo                 # local path → used directly
```

Unknown bare names fall back to a GitHub API search by stars.

### Pin formats

- `--pin branch:<name>` — track a branch (auto-syncs)
- `--pin tag:<name>` — pin to a tag
- `--pin commit:<hash>` — pin to a specific commit (a short hash of 4 or more hex characters works)
- `--pin <40-char-hash>` — the same, for a full commit hash
- `--pin <name>` — a bare name: a tag of that name if the remote has one, else a branch
- `--pin auto` — resolve version from `package.json` dependencies

### Clone behavior

All clones default to `--depth 1` and `--single-branch` since repos are for code reference, not building. Use `--depth` to override.

Repos on the shelf are caches: sync force-checks out the pinned ref and discards any local edits to tracked files.

`shelf remove <alias>` also cleans up an orphan folder: a folder under `repos/` with no config entry.

`shelf remove` first moves the repo folder aside, then drops the config entry, then renames the moved folder to trash (`repos/.shelf-trash-<alias>-<id>/`) and deletes it. If the move fails, nothing changes; if the config can't be saved, the folder is moved back. If the delete fails, the repo is still removed from the shelf: shelf warns and leaves the trash folder, and the next `shelf remove` or `shelf prune` (without `--dry-run`) deletes it.

`shelf add` clones into `repos/.shelf-add-<alias>-<pid>-<id>/` and moves the clone into place once it is done, so a half-made clone never shows up as a repo.

If an add, a remove or a case-only `shelf alias` (`react` to `React`) is killed partway, its hidden folder names the process (`<pid>`) that made it. Once that process is gone, the next `shelf remove` or `shelf prune` (without `--dry-run`) moves it back or deletes it: a killed remove's or alias change's folder moves back when its repo is still in the config and has no folder, and anything else is deleted.

## Detection

| Command                           | Purpose                                           |
| --------------------------------- | ------------------------------------------------- |
| `shelf detect [--dir path]`       | Scan project dependencies and show matching repos |
| `shelf detect --apply`            | Detect and add all found repos                    |
| `shelf detect --format shelffile` | Output detected repos in shelffile format         |

Scans `package.json` (npm) and `go.mod` (Go) for dependencies. Matches against the built-in registry first (instant, no network), then falls back to the npm registry API.

## Shelffile

| Command                                        | Purpose                                                 |
| ---------------------------------------------- | ------------------------------------------------------- |
| `shelf install [--dir path] [--concurrency N]` | Install repos from a shelffile (default concurrency: 4) |
| `shelf share [--filter aliases] [--stdout]`    | Generate a shelffile from current repos                 |

When a shelffile alias is already on the shelf with a different URL or pin, `shelf install` warns and leaves the stored repo as it is.

## Daemon

| Command                             | Purpose                                     |
| ----------------------------------- | ------------------------------------------- |
| `shelf daemon start [--foreground]` | Start background sync daemon                |
| `shelf daemon stop`                 | Stop the daemon                             |
| `shelf daemon status`               | Show daemon status (PID, uptime, last sync) |
| `shelf daemon logs [--lines N]`     | Show daemon log output (default: 50 lines)  |
| `shelf daemon restart`              | Stop and restart the daemon                 |

The daemon runs `syncAll()` on a configurable interval (`shelf config syncIntervalMinutes <N>`, default 60), syncing up to 4 repos at a time. It re-reads config each cycle so new repos are picked up automatically. Only one daemon runs at a time: a second `shelf daemon start` reports the running one.

## Management

| Command                                   | Purpose                                                                                                           |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `shelf status`                            | Show detailed status of all repos                                                                                 |
| `shelf info <alias>`                      | Detailed info for a single repo                                                                                   |
| `shelf pin <alias> <ref>`                 | Pin a repo to a branch, tag, or commit                                                                            |
| `shelf alias <old> <new>`                 | Rename a repo alias                                                                                               |
| `shelf prune [--dry-run] [--force]`       | Remove unreferenced repos                                                                                         |
| `shelf config [key] [value]`              | View or modify configuration                                                                                      |
| `shelf init [--agent name] [--no-detect]` | Scaffold a skill file and detect project repos; `--agent` is claude, opencode or gemini; other names are rejected |

The skill `shelf init` writes names the repos folder of the resolved shelf home (`$SHELF_HOME/repos`, or `~/.agents/shelf/repos` by default).
