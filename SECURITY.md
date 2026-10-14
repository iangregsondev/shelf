# Security Policy

## Reporting a vulnerability

Please do **not** report security vulnerabilities through public GitHub issues,
discussions, or pull requests — a public report is itself a disclosure.

Instead, use
[GitHub's private vulnerability reporting](https://github.com/iangregsondev/shelf/security/advisories/new)
to open a draft advisory. It's private, and it lets us work on the fix and the
advisory in the same place.

Please include:

- what the problem is and why it's a security issue rather than a bug;
- the command or file affected, and the version (`shelf --version`) or commit;
- steps to reproduce, or a proof of concept;
- what an attacker could achieve with it.

## What counts as a vulnerability here

Shelf is a CLI that clones and syncs git repositories into a local cache and runs
a background daemon. Realistic threats include:

- **Writing outside the shelf home** — an alias, URL or shelffile entry that makes
  shelf create, overwrite or delete files elsewhere on disk.
- **Command injection** — input that ends up executed by a shell or passed to
  `git` as an option rather than an argument.
- **Fetching from an unexpected source** — resolution that clones a repository
  other than the one the user asked for.
- **A supply-chain problem** — the build, the publish workflow, or a dependency.

Ordinary bugs — a command fails, or a sync misses an update — aren't security
issues. Open a normal [issue](https://github.com/iangregsondev/shelf/issues) for those.

## Supported versions

Only the latest release on npm and the current `main` branch receive fixes.

## What to expect

This repo is maintained by one person in their own time, so there's no guaranteed
response time and no bug bounty. Reports are read and handled on a best-effort
basis.

If a report is valid, the fix lands on `main`, a patched release is published, and
a GitHub advisory follows. Credit is given to the reporter unless you'd rather stay
anonymous — say which you prefer in the report.
