# Companion

Companion is a self-hosted engineering dashboard that plugs into GitHub and manages repositories end-to-end with [moxxy](https://github.com/moxxy-ai/moxxy) agents. It can triage issues, review pull requests with CI context, run user-defined PR pipelines, implement proposals into PRs, and automate work through webhooks and schedules.

## What you get

Everything is scoped to a **workspace** (a named group of repositories). Each workspace includes:

- **Proposals** — capture business requests, analyze them, and turn approved proposals into implementation runs.
- **Issues** — sync GitHub issues and launch triage/fix agents.
- **Pull Requests** — review PRs, inspect CI status, and run manual or automatic pipelines.
- **Pipelines** — compose typed steps such as CI gates, AI review, custom agent runs, labels, and comments.
- **Agent Runs** — monitor every moxxy-backed run and its lifecycle.
- **Automations, Repositories, Settings, Users, and Runners** — configure workspace behavior, access, and execution machines.

Auth and RBAC are built in. The three roles are `admin` (everything), `maintainer` (day-to-day repo work), and `business` (proposals only). Every REST route declares the permission it requires, and the SPA hides modules the signed-in role cannot use.

Keyboard shortcuts: `g` + a module key jumps between modules, `/` focuses search, and `?` opens the shortcuts cheatsheet.

## Architecture

moxxy is an **external runtime**, not a package dependency in this repository. Companion expects the `moxxy` CLI to be installed and drives it over the moxxy gateway wire protocol.

Every agent run uses its own `moxxy serve` + gateway process pair under an isolated `MOXXY_HOME` inside Companion's data directory (`~/.companion/moxxy-home` by default, `/data/moxxy-home` in Docker). This keeps Companion sessions separate from the user's normal moxxy desktop/TUI/CLI sessions.

### Runners (multi-machine execution)

A **runner** is a machine that executes agent work. Companion ships with the built-in **local runner** — the machine `companion-api` runs on — and can attach any number of **remote runners**: other machines running the `companion-runner` agent, reached over the network with a bearer token.

Each runner is either **shared** (eligible for any workspace) or **delegated** (serves only the workspaces you assign it), and repos can pin a preferred runner. When an agent run starts, Companion places it on an eligible, online runner and prepares its git worktree there, so the whole run — gateway, clone, worktree, and session history — lives on one machine. Placement is **provider-aware**: runners advertise the model providers configured in their moxxy home, Companion prefers a runner that can serve the run's pinned/default model, never places work on a runner with no providers at all, and if a run still lands where its model isn't available, that turn quietly rides the runner's own default model instead of failing. The local execution path is unchanged; remote runners are entirely additive. Manage them in the admin **Runners** module.

The agent publishes as a standalone package — a machine needs only Node and the moxxy CLI, not a Companion checkout. To attach one, install it, check it's ready, start it, and register the endpoint + token in Runners:

```sh
npm i -g @moxxy/companion-runner
companion-runner setup   # installs the moxxy CLI if missing, imports providers, opens the firewall

COMPANION_RUNNER_TOKEN=<shared-secret> companion-runner --background
```

No GitHub credential is needed on the box — Companion sends its own configured GitHub token with each clone and push (set `COMPANION_RUNNER_GITHUB_TOKEN` to override with a machine-specific PAT). `companion-runner doctor` reports what a box still needs; `status`/`stop` manage a background runner. See `apps/companion-runner/README.md` for the full environment. (In a monorepo checkout: `pnpm --filter @moxxy/companion-runner dev`.)

### Modular framework

Companion is built as a **modular framework**. A small framework core
(`@companion/core`) hosts feature **modules** — one per domain (`core`,
`workspace`, `operate`, `code`, `plan`, `automations`, `admin`) under `modules/*`
— that are **loaded, migrated, permissioned, and toggled at runtime**. Each
module ships its own tables (with per-module migrations + rollback), REST/WS
routes, RBAC permissions, background jobs, and web pages, and declares which
other modules it depends on. The kernel reconciles the installed set on boot,
activates modules in dependency order, and lets an admin enable/disable/uninstall
any non-required module live from the **Modules** page — its API flips to `503`,
its nav and routes disappear, and its permissions drop from the grid, with no
restart. Installing a new module is one entry in each app's module registry.

**To build a module, read [`modules/README.md`](modules/README.md)** — the
complete authoring guide — or invoke the `companion-build-module` skill /
`module-builder` agent.

## Repository layout

- `apps/api` — the daemon: boots the **kernel** (`@companion/core`), holds the static module registry, and runs the HTTP/WS server. Feature logic lives in the modules it loads, not here.
- `apps/web` — the React/Vite SPA **shell**: `ModulesProvider` + the single-socket net layer. It hosts and presents modules' client slices; it contains no feature pages of its own.
- `apps/companion-runner` — the machine-holder agent: a slim daemon that lets a remote box execute Companion agent work (spawns moxxy gateways, holds clones/worktrees, streams events) driven by a `companion-api` over HTTP+WS.
- `packages/*` — the framework: `@companion/types` (primitives), `@companion/contracts` (the open RBAC/WS/service registries), `@companion/services` (base store/service utils), `@companion/core` (the kernel + registrant API + client host), `@companion/ui` (design-system kit).
- `modules/*` — the feature domains, one `@companion/module-<id>` package each. See [`modules/README.md`](modules/README.md).

## Prerequisites

- Node.js 20 or newer.
- pnpm 10 (Corepack is recommended: `corepack enable`).
- Git.
- Optional for local agent runs: moxxy CLI (`npm i -g @moxxy/cli`). The daemon still starts without it, but agent runs fail until it is installed.
- Optional for Docker bootstrap: Docker and Docker Compose.

## Getting started locally

1. Install dependencies:

   ```sh
   corepack enable
   pnpm install
   ```

2. Create a local environment file:

   ```sh
   cp .env.example .env
   ```

   Edit `.env` and change at least `COMPANION_ADMIN_PASSWORD`. Accounts in `.env` are seed accounts: they are imported once into an empty user store, after which the Users admin module owns accounts.

   A clean setup with no seeded credentials runs first-boot onboarding in the browser instead.

3. Start the development servers:

   ```sh
   pnpm dev
   ```

   This runs companion-api on <http://127.0.0.1:8901> and Vite on <http://127.0.0.1:5173>. Vite proxies `/api` and `/ws` to companion-api.

4. Open <http://127.0.0.1:5173> and sign in with the seeded admin account, or complete first-boot onboarding.

5. In Settings, add a GitHub token/account for repository sync and agent operations.

## Docker quick start

Docker is the fastest way to bootstrap Companion on a new machine.

1. Create an environment file:

   ```sh
   cp .env.example .env
   ```

   Change the default password before exposing the service beyond localhost.

2. Build and start the stack:

   ```sh
   docker compose up --build
   ```

3. Open <http://127.0.0.1:8901>.

The compose file stores Companion data in the named volume `companion-data` mounted at `/data` in the container. That volume contains the SQLite database, cloned repositories/worktrees, the isolated moxxy home, and daemon config.

Useful Docker commands:

```sh
# Start in the background
docker compose up -d --build

# Follow logs
docker compose logs -f companion

# Stop the service
docker compose down

# Stop and remove persisted Companion data (destructive)
docker compose down -v
```

The image installs `@moxxy/cli` globally so agent runs can start inside the container. If your repositories require SSH access, mount an SSH configuration/key into the container and make sure the key has the appropriate GitHub permissions.

### Deploying with Coolify

The image is self-contained (companion-api + built SPA + git + moxxy CLI) and ships a `HEALTHCHECK` against the unauthenticated `/healthz` endpoint, so Coolify can gate deploys on it. Point Coolify at the repository and either build pack works:

- **Dockerfile** — port `8901`; add a persistent storage mount at `/data`.
- **Docker Compose** — uses `docker-compose.yml` as is (the `.env` file is optional; the named `companion-data` volume persists `/data`).

Set environment variables (admin credentials, `COMPANION_HOST=0.0.0.0`, etc.) in Coolify's UI — they take precedence over any `.env`.

**Model providers in a container:** the image ships the moxxy CLI, but a fresh container has no provider credentials (there is no `~/.moxxy` to import from, and `moxxy init` has never run). Two ways to get agent runs working:

- **Exec in once** — `docker exec -it <container> sh`, then run moxxy's own login/init with the home pinned into the persistent volume: `MOXXY_HOME=/data/moxxy-home moxxy init`. Credentials survive redeploys because they live in `/data`. An API-key provider is the right choice on a server; OAuth-based credentials rotate their refresh token on every use and should not be shared across machines.
- **Skip local execution entirely** — leave the container provider-less as a pure control plane (UI, GitHub sync, orchestration) and attach remote runners (machines where moxxy is already configured) to execute all agent work.

## Configuration

Companion reads configuration from real environment variables, then `./.env`, then `~/.companion/.env` for local runs. In Docker, Compose passes variables from `.env` and sets `COMPANION_HOME=/data`.

Common variables:

| Variable | Default | Description |
| --- | --- | --- |
| `COMPANION_HOST` | `127.0.0.1` | HTTP and WebSocket bind host. Docker Compose sets this to `0.0.0.0` for published ports. |
| `COMPANION_PORT` | `8901` | HTTP and WebSocket port for companion-api. |
| `COMPANION_HOME` | `~/.companion` | Data directory for the SQLite DB, cloned repos, worktrees, and isolated moxxy home. |
| `COMPANION_MODEL` | `gpt-5.5` | Default model passed to agent runs. |
| `COMPANION_ADMIN_USER` / `COMPANION_ADMIN_PASSWORD` | unset | Seed admin account. |
| `COMPANION_MAINTAINER_USER` / `COMPANION_MAINTAINER_PASSWORD` | unset | Optional seed maintainer account. |
| `COMPANION_BUSINESS_USER` / `COMPANION_BUSINESS_PASSWORD` | unset | Optional seed business account. |

Advanced daemon settings such as `maxLiveRuns` and `moxxyCliPath` are stored in `${COMPANION_HOME}/companion-api.json` after first boot.

## Development commands

```sh
pnpm dev        # run companion-api and the Vite web app in development mode
pnpm build      # build all workspace packages
pnpm typecheck  # type-check all workspace packages
pnpm test       # run workspace tests where present
```

## Production build without Docker

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter companion-api start
```

After `pnpm build`, companion-api serves the built SPA from `apps/web/dist` when present.

### Run under pm2

`ecosystem.config.cjs` runs the whole suite (companion-api serving the built SPA, local runner included) as a managed process:

```sh
npm i -g pm2
pnpm prod            # pnpm -r build && pm2 startOrRestart ecosystem.config.cjs

pm2 logs companion   # follow logs
pm2 save && pm2 startup   # survive reboots
```

Configuration comes from companion-api's layered env (`process env > ./.env > ~/.companion/.env`), so no pm2-specific settings are needed. The file also has a commented-out entry for serving a `companion-runner` agent from the same checkout.
