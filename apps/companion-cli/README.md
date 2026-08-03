<div align="center">

<img src="https://raw.githubusercontent.com/moxxy-ai/companion/main/docs/brand/mark-tile.svg" width="72" height="72" alt="Companion" />

# Companion

**A self-hosted maintainer's dashboard that runs your repositories with AI agents.**

[![npm](https://img.shields.io/npm/v/@moxxy/companion?color=111&label=npm)](https://www.npmjs.com/package/@moxxy/companion)
[![downloads](https://img.shields.io/npm/dm/@moxxy/companion?color=111&label=downloads)](https://www.npmjs.com/package/@moxxy/companion)
[![node](https://img.shields.io/node/v/@moxxy/companion?color=111&label=node)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@moxxy/companion?color=111&label=license)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/moxxy-ai/companion/actions/workflows/ci.yml/badge.svg)](https://github.com/moxxy-ai/companion/actions/workflows/ci.yml)

```sh
npx @moxxy/companion
```

</div>

---

Companion is the control plane between you and a fleet of coding agents. It syncs
your GitHub repositories, turns issues into reviewed work, runs agents on the
machines you choose, and keeps every action behind a permission you can audit.

One command starts the whole thing: an HTTP daemon, a single-page dashboard, and
a SQLite database, all under `~/.companion`. No container, no Postgres, no
account anywhere.

## Getting started

```sh
npx @moxxy/companion
```

First run walks through three things and takes under a minute:

1. **An admin account.** Accept the recommended local defaults and a random
   password is generated and shown once, or enter your own.
2. **A module set.** *Slim* is the recommendation: repositories, agent runs,
   durable contributor workflows, planning, automations and administration.
   *Full* adds refinement, ideas, contribution-quality analysis, the playground and delivery
   integrations. *Custom* lets you pick. Nothing is permanent, and everything
   is one click away later on the Modules page.
3. **A GitHub identity**, if `gh` is already signed in. The token is read from
   `gh` only after you confirm, goes straight to the local API, and is never
   printed or written to a setup file.

Then Companion starts on <http://127.0.0.1:8901> and opens your browser. Later
runs reuse the data directory and skip setup entirely.

### Without a terminal

`--background` starts the daemon as its own process, detached from the shell.
Setup still happens in front of you; when it is done the CLI returns and
Companion keeps running, so the terminal can be closed.

```sh
npx @moxxy/companion --background   # start, then hand the terminal back
npx @moxxy/companion stop           # stop it again
```

Output goes to `~/.companion/companiond.log` (rolled at 5 MB, one file kept)
instead of the screen. `stop` reads the pid from the data directory, so it stops
the instance for that `--home` however it was started. Running `npx
@moxxy/companion` again while one is up just opens the browser.

### Non-interactive

```sh
COMPANION_PROFILE=full npx @moxxy/companion --yes --no-open
```

| Flag / variable | Effect |
|---|---|
| `--yes`, `-y` | Accept generated defaults; never prompt |
| `--no-open` | Do not open a browser |
| `--background` | Leave the daemon running after the CLI exits |
| `--port <n>`, `--host <h>` | Bind somewhere other than `127.0.0.1:8901` |
| `--home <path>` | Use a different data directory |
| `COMPANION_PROFILE` | `slim` or `full`, instead of the prompt |
| `COMPANION_ADMIN_USER` + `COMPANION_ADMIN_PASSWORD` | Seed the first admin and skip the wizard entirely |

Run `npx @moxxy/companion init` to do setup without starting the server.

## Running agents

The dashboard works on its own. **Agent runs need the moxxy CLI**, which holds
your model provider credentials:

```sh
npm i -g @moxxy/cli && moxxy onboard
```

Companion never sees a provider key. It asks moxxy to run a turn, on this
machine or on a remote one you have connected as a runner.

## Managing an instance

Every screen has a CLI equivalent, authenticated by a token the daemon mints at
boot into `~/.companion/cli-token` (mode 0600):

```sh
companion module list                # what is installed, available, or off
companion module install board       # adopt a module (runs its migrations)
companion acl explain alice prs:act  # why a permission is granted or refused
companion role create release-manager --from maintainer
companion user role alice release-manager
```

## What you get

- **Repositories.** GitHub as the source of truth, synced and cached, never
  duplicated. Multiple accounts, scoped per workspace, each owned by one profile.
- **Issues and pull requests.** Triage, AI review, CI analysis, and fixes that
  arrive as real pull requests.
- **Agent runs.** Every run visible, resumable and attributable, across as many
  machines as you connect.
- **Roles you define.** Three built-in roles, any number of your own, composed
  from the permission catalogue. An explicit revoke always beats a module grant.
- **An audit trail.** Every mutating request, refusals included, with retention
  and NDJSON export behind its own permission.
- **Modules.** Install, enable, disable and configure at runtime. What ships is
  a build profile; what runs is your choice.

## Requirements

- **Node.js 24 or newer** for the dashboard. Nothing is compiled at install time:
  the database is Node's built-in SQLite.
- **git** on `PATH` for repository work.
- **[moxxy](https://www.npmjs.com/package/@moxxy/cli)** for agent runs.

## Data and privacy

Everything lives in `~/.companion`: the SQLite database, cloned repositories,
worktrees, and an isolated moxxy home. Back it up by copying `companion.db` and
its `-wal`. There is no telemetry, no update check and no CDN fetch on any boot
or request path, which is what makes an air-gapped install possible.

Companion is a **single-node appliance** by design. Execution scales horizontally
through runners; the control plane does not. A second daemon pointed at the same
data directory refuses to start rather than corrupting it.

## Licence

MIT.
