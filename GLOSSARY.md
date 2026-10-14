# Shelf

Shelf keeps a global, always-current cache of code reference repositories on the local machine, so AI agents can read real source code with their native tools.

## Language

### The cache

**Shelf**:
The machine-wide cache of reference repos and the state that describes them, rooted at the shelf home.
_Avoid_: store, library

**Shelf home**:
The directory holding all shelf state; `~/.agents/shelf` unless overridden.
_Avoid_: data dir, cache dir

**User home**:
The user's own home folder (`os.homedir()`), which holds the default shelf home and is shown as `~` in paths.
_Avoid_: home dir, home (alone; say shelf home or user home)

**Reference repo**:
A git repository cloned onto the shelf for reading, never for editing.
_Avoid_: dependency, package, entry

**Alias**:
The unique name a reference repo goes by on the shelf; also its folder name, so it is a single safe path segment.
_Avoid_: name, id, slug

**Orphan folder**:
A folder in the repos folder named like an alias but with no config entry; it blocks `add` under that alias, and `remove` deletes it.
_Avoid_: stray folder, leftover

**Trash**:
The folder of a removed reference repo, renamed aside (`.shelf-trash-…`) and waiting to be deleted; `remove` and `prune` delete it. A dead temp folder becomes trash too, unless it can move back.
_Avoid_: bin, garbage

**Dead temp folder**:
A hidden folder an add, a remove or a case-only alias change was working in (`.shelf-add-…`, `.shelf-removing-…`, `.shelf-rename-…`) whose process is gone, because it was killed partway. `remove` and `prune` move it back to its repo or turn it into trash.
_Avoid_: leftover, stale folder

**Shorthand**:
A short way of naming a repo that shelf expands to a full git URL, such as `owner/repo`, `github:owner/repo` or a known package name.
_Avoid_: short name, slug

### Pins

**Pin**:
What a reference repo is held to: a branch, a tag or a commit. A repo with no pin follows its default branch.
_Avoid_: version, lock, ref

**Branch pin**:
A pin that follows the tip of a named branch.

**Tag pin**:
A pin fixed to a named tag.

**Commit pin**:
A pin fixed to one commit, always stored as its full 40-character hash.
_Avoid_: SHA pin

**Auto-pin**:
A tag pin chosen by matching the version a project declares for a package against the repo's tags.

### Keeping current

**Sync**:
Bringing a reference repo's files up to date with its pin.
_Avoid_: pull, refresh, update (except as the CLI command name)

**Daemon**:
The background process that syncs every reference repo on an interval.
_Avoid_: watcher, worker, service

### Projects

**Project**:
A directory on the user's machine whose work refers to reference repos.
_Avoid_: workspace, app

**Shelffile**:
A per-project file listing the reference repos that project wants, each with an alias, URL and optional pin.
_Avoid_: manifest, lockfile

**Registry**:
The shelf's record of which projects have installed from a shelffile, used to tell which reference repos are still referenced.
_Avoid_: index, project list

**Prune**:
Removing reference repos that no registered project's shelffile references, and deleting any trash.
_Avoid_: cleanup, gc
