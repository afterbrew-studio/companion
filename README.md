<h1><img src="docs/brand/mark-tile.svg" width="28" height="28" align="top" alt=""> Companion</h1>

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
any non-required module live from the **Modules** page or the CLI; its API
flips to `503`, its nav and routes disappear, and its permissions drop from the
grid, with no restart. Which modules a build *contains* is a
[build profile](#build-profiles-what-ships); which of those are *running* is
runtime state.

**To build a module, read [`modules/README.md`](modules/README.md)** — the
complete authoring guide — or invoke the `companion-build-module` skill /
`module-builder` agent.

**Running Companion for an organisation?** See [`ENTERPRISE.md`](ENTERPRISE.md)
for roles, audit, deployment shape, and an honest list of what is not built yet.

## Repository layout

- `apps/api` — the daemon: boots the **kernel** (`@companion/core`), holds the static module registry, and runs the HTTP/WS server. Feature logic lives in the modules it loads, not here.
- `apps/web` — the React/Vite SPA **shell**: `ModulesProvider` + the single-socket net layer. It hosts and presents modules' client slices; it contains no feature pages of its own.
- `apps/companion-runner` — the machine-holder agent: a slim daemon that lets a remote box execute Companion agent work (spawns moxxy gateways, holds clones/worktrees, streams events) driven by a `companion-api` over HTTP+WS.
- `packages/*` — the framework: `@companion/types` (primitives), `@companion/contracts` (the open RBAC/WS/service registries), `@companion/services` (base store/service utils), `@companion/core` (the kernel + registrant API + client host), `@companion/ui` (design-system kit), `@moxxy-ai/companion-sdk` (the curated ABI in-tree feature modules and out-of-tree modules both compile against).
- `modules/*` — the feature domains, one `@companion/module-<id>` package each. See [`modules/README.md`](modules/README.md).

## Prerequisites

- Node.js 20 or newer.
- pnpm 10 (Corepack is recommended: `corepack enable`).
- Git.
- Optional for local agent runs: moxxy CLI (`npm i -g @moxxy/cli`). The daemon still starts without it, but agent runs fail until it is installed.
- Optional for Docker bootstrap: Docker and Docker Compose.

## One-command local start

The published CLI contains both companion-api and the built SPA:

```sh
npx @moxxy/companion
```

On first launch, choose an admin username, email, and password, or press Enter
to use the recommended local defaults. The default password is generated
randomly and shown once in a confirmation box. Later launches reuse the data in
`~/.companion`, start Companion at <http://127.0.0.1:8901>, and open the browser
without repeating setup.

If GitHub CLI is already authenticated, the interactive setup offers to connect
its active `github.com` identity as a personal GitHub account owned by the new
admin. The token is read from `gh` only after confirmation, sent to the local
Companion API, and never printed or copied into the CLI configuration.

Use `npx @moxxy/companion init` for setup without starting the server,
or add `--no-open`, `--port`, or `--home` as needed. Node.js 20+ is the only
requirement for the dashboard; install the external moxxy CLI before running AI
agents.

### The first admin: wizard, or seeded from the environment

With no credentials in the environment, an instance with an empty user store
sends you through first-run setup in the browser.

`COMPANION_ADMIN_USER` + `COMPANION_ADMIN_PASSWORD` **replace that wizard**: the
account is seeded on the first boot that finds no users, and the setup screen
never appears. That is the normal shape for a container deployment, and it is
worth knowing before you go looking for a setup step that is not coming.

Those variables are seeds, not state. They are read only while the user store is
empty, after which the database is authoritative and the Users page owns
accounts. Two consequences: changing the variable later does nothing, and
recreating the database re-seeds the account with whatever the variable says
now, discarding a password changed in the UI.

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

3. Build once:

   ```sh
   pnpm build
   ```

   Contributors usually want every module, not the shipped default. Set it once
   and `install`, `dev`, `build` and `typecheck` all follow:

   ```sh
   export COMPANION_PROFILE=full
   ```

4. Start the development servers:

   ```sh
   pnpm dev
   ```

   This runs companion-api on <http://127.0.0.1:8901> and Vite on <http://127.0.0.1:5173>. Vite proxies `/api` and `/ws` to companion-api.

5. Open <http://127.0.0.1:5173> and sign in with the seeded admin account, or complete first-boot onboarding.

6. In Settings, add a GitHub token/account for repository sync and agent operations.

7. Optional: turn on the modules you want from the **Modules** admin page. A
   fresh install enables `core`, `workspace`, `operate`, `code` and `admin`; the
   planning cluster and the reactors wait under **Available**.

Before opening a PR, run what CI runs:

```sh
pnpm build && pnpm typecheck && pnpm acl check
```

## Docker quick start

The image runs the same bundle as the npx package: the build stage compiles the
workspace and the runtime stage carries only `dist/` plus four runtime
dependencies. Choose the module set with a build arg:

```sh
docker build --build-arg PROFILE=slim -t companion:slim .   # default
COMPANION_PROFILE=full docker compose up -d --build
```


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

- **Dockerfile**: port `8901`; add persistent storage at `/data` **and** at
  `/root/.moxxy`. The second one holds the AI provider credentials, and without
  it every redeploy loses them.
- **Docker Compose**: uses `docker-compose.yml` as is, which already declares
  both volumes (the `.env` file is optional).

Set environment variables (admin credentials, `COMPANION_HOST=0.0.0.0`, etc.) in Coolify's UI — they take precedence over any `.env`.

#### Deploying the full module set

**The profile is a build argument, not a runtime variable.** Setting
`COMPANION_PROFILE=full` as an ordinary environment variable changes nothing: by
the time the container starts, the module set is already compiled in. In
Coolify, mark it as a **build variable** (the per-variable toggle), or set the
build arg directly:

- **Dockerfile build pack**: build arg `PROFILE=full`.
- **Docker Compose build pack**: variable `COMPANION_PROFILE=full` marked as a
  build variable, which `docker-compose.yml` forwards to the same build arg.

Confirm it in the **build log**, not on the running instance: the generator
prints the profile it used, and that one line separates the three things that
look identical from outside.

| In the build log | What it means |
|---|---|
| `profile 'full': 13 module(s)` | The build was right. If the app still shows five, a stale container is running. |
| `profile 'slim': 5 module(s)` | The build argument never arrived. |
| no `profile '...'` line at all | Docker reused a cached layer, which also proves the argument never changed: a real change from `slim` to `full` invalidates that layer. |

The last two mean the same thing, and rebuilding without cache will not fix
them: the variable is not reaching the build. Switching the app to the **Docker
Compose** build pack is the reliable way out, since the compose file maps
`COMPANION_PROFILE` to the build argument itself.

A `full` build still boots with only the slim five enabled: the rest ship as
**Available** and an admin adopts them. See
[Turning on everything a `full` build contains](#turning-on-everything-a-full-build-contains)
for the install order, and set `COMPANION_PUBLIC_URL` to your domain so SSO and
webhooks have an address to come back to.

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
| `COMPANION_ADMIN_USER` / `COMPANION_ADMIN_EMAIL` / `COMPANION_ADMIN_PASSWORD` | unset | Seed admin account. |
| `COMPANION_MAINTAINER_USER` / `COMPANION_MAINTAINER_PASSWORD` | unset | Optional seed maintainer account. |
| `COMPANION_BUSINESS_USER` / `COMPANION_BUSINESS_PASSWORD` | unset | Optional seed business account. |

Advanced daemon settings such as `maxLiveRuns` and `moxxyCliPath` are stored in `${COMPANION_HOME}/companiond.json` after first boot.

## Development commands

```sh
pnpm dev             # run companion-api and the Vite web app in development mode
pnpm build           # generate the module registries, then build all packages
pnpm typecheck       # generate, then type-check all packages
pnpm test            # run workspace tests where present

pnpm gen:modules --profile <slim|full>   # rewrite the registries (usually automatic)
pnpm acl check                           # RBAC gate (also runs in CI)
pnpm acl map --by role                   # what each built-in role holds
pnpm sdk:surface                         # the published module ABI (also runs in CI)
```

`pnpm build` and `pnpm typecheck` run `gen:modules` first, so a fresh clone
works without any extra step.

## Build profiles: what ships

The set of modules a build **contains** is named in exactly one place,
`profiles/*.json`:

| Profile | Modules | Used for |
|---|---|---|
| `slim` (default) | `core`, `workspace`, `operate`, `code`, `admin` | the published npx package and the OSS image |
| `full` | `slim` + `plan`, `board`, `refinement`, `planner`, `automations`, `slop`, `playground`, `oidc` | everything in this repo |
| `minimal` | `core`, `workspace` | the guard that the app shell depends on no optional module |

```sh
export COMPANION_PROFILE=full   # or: pnpm gen:modules --profile full
pnpm build
```

**The profile is chosen when the artifact is built, not when it runs**, so which
install path you use decides whether you can pick one at all:

| Install path | Profile |
|---|---|
| `npx @moxxy/companion` | `slim`, fixed. The registry is baked into the published bundle. |
| Docker | `--build-arg PROFILE=full`, or `COMPANION_PROFILE=full` via compose |
| From source | `COMPANION_PROFILE=full pnpm build` |

Setting `COMPANION_PROFILE` as a *runtime* variable does nothing: by the time the
process starts, the module set is already compiled in. That failure is silent,
so check the build output rather than the running instance. The generator prints
exactly what it produced:

```
profile 'full': 13 module(s) [core, workspace, admin, oidc, operate, code, board, ...]
```

The registries (`apps/*/src/modules.generated.ts`) are **gitignored** and
regenerated automatically by `pnpm install`, `dev`, `build` and `typecheck`, so
you never have to run the generator yourself. A committed registry would drift
from the profile the moment someone edited one and not the other.

The generator refuses a profile that is not closed under `dependsOn`, or that
omits a `required: true` module, naming both sides:

```
profile is not buildable:
  'code' depends on 'operate', which the profile omits
  'workspace' is required and cannot be excluded from a build
```

Being in a build is not the same as being on. Optional modules ship with
`autoInstall: false`, so a fresh `full` install still boots with the slim five
enabled and the rest waiting under **Available**.

## Pointing at GitHub Enterprise Server

Two settings, by environment or in `$COMPANION_HOME/companiond.json`:

```sh
COMPANION_GITHUB_API_URL=https://ghe.corp/api/v3   # must include the API path
COMPANION_GITHUB_HOST=ghe.corp
```

They drive the REST client, `git clone`, the `gh --hostname` used to adopt your
local identity at boot, and the GitHub links in the UI. Defaults are github.com.

Behind an egress proxy, set `HTTP_PROXY` / `HTTPS_PROXY` (and `NO_PROXY`). The
daemon installs a proxy-aware dispatcher at boot when one of them is present, and
logs which one it used. See [`ENTERPRISE.md`](ENTERPRISE.md) §6.

## Managing modules

From the **Modules** admin page, or from the CLI against a running daemon:

```sh
companion module list                     # every module in this build and its state
companion module info slop                # dependencies, permissions, config spec
companion module install slop --set label=ai-slop
companion module enable slop
companion module disable slop             # stops it, keeps its tables and config
companion module uninstall slop           # rolls back its migrations, wipes its config
companion module config slop --set label=junk
```

`install` also enables, and is idempotent: running it on a module that is
already on applies any `--set` config and returns. `disable` is reversible;
`uninstall` is not, and asks before running (`--yes` in scripts). Installing
runs the module's migrations; uninstalling rolls them back to zero and clears
the migration ledger, so a later re-install starts clean.

### Turning on everything a `full` build contains

A `full` build is not a full instance. Every optional module declares
`autoInstall: false`, so straight after the deploy the running surface is
identical to `slim`; the difference is what you can turn on without rebuilding.

First confirm the build actually contains them, because a missed build argument
looks exactly like a module that refuses to install:

```sh
companion module list        # expect 13 modules, 5 enabled (not "5 of 5")
```

`Unknown module: plan` means the module is not in this build at all, so no
amount of installing will help: rebuild with the right profile.

Then adopt them. The order satisfies `dependsOn` (`refinement` and `planner`
need `plan` and `board`), and the kernel refuses an out-of-order install rather
than half-enabling anything:

```sh
for m in plan board refinement planner automations slop playground; do
  companion module install "$m"
done
```

`oidc` is deliberately not in that list. It needs its provider configured first,
and `COMPANION_PUBLIC_URL` set to the address the provider redirects back to:

```sh
companion module install oidc   --set issuer=https://example.okta.com   --set clientId=... --set clientSecret=...
```

In Docker, run these inside the container (`docker exec -it <container> sh`),
where the CLI finds the daemon and its token in `/data`.

The CLI authenticates with a token the daemon mints at boot into
`$COMPANION_HOME/cli-token` (mode 0600). It is an admin-equivalent credential;
the directory already holds the database, so it does not widen that blast radius.

## Out-of-tree modules

A module does not have to live in this repo. `@moxxy-ai/companion-sdk` is the
published authoring surface, and a daemon loads anything installed into
`$COMPANION_HOME/modules/<id>/`.

This covers the whole module surface: routes, services, migrations, permissions,
background jobs, config, plus nav entries and pages. The browser side works
through an import map the app emits, so a module chunk shares the host's React
and SDK instead of bundling its own.

An out-of-tree module depends on exactly two packages:

```jsonc
{
  "devDependencies": { "@moxxy-ai/companion-sdk": "^0.1.0", "@companion/contracts": "^0.1.0" },
  "peerDependencies": { "@moxxy-ai/companion-sdk": "^0.1.0" },
  "moxxy": {
    "id": "hello",           // must equal the install directory name
    "abi": "0.x",            // the ABI generation, checked at boot
    "manifest": "./dist/module.js",
    "api": "./dist/api.js"
  }
}
```

Everything is imported from the SDK except one line: registry augmentation must
target `@companion/contracts`, because TypeScript binds declaration merging to
the package that declares the interface and a façade would silently produce a
second, empty registry.

```ts
declare module '@companion/contracts' {
  interface PermissionRegistry { 'hello:read': true }
}
```

Build with the ABI marked external, publish `dist/` and `package.json` with **no
`node_modules`**, then:

```sh
companion module verify ./dist-package     # static ABI check, no daemon needed
cp -r ./dist-package "$COMPANION_HOME/modules/hello"
companion module install hello && companion module enable hello
```

`verify` refuses a module that vendors an ABI package or imports outside the
allowlist, and the daemon refuses the same at boot with the reason in its log
while the other modules keep loading. That check exists because the failure is
silent otherwise: a second copy of the SDK means a second `Reply` class, and
`redirect()` starts returning HTTP 200 with a JSON body instead of a 302.

A module with a UI also declares `moxxy.client` and builds a browser chunk with
`react`, `react/jsx-runtime` and the SDK subpaths **external**, for production.
The app serves those six specifiers at stable `/host/*.js` URLs and maps them in
an import map, so the module gets the host's React rather than a second one. A
chunk that cannot resolve them fails loudly and drops only itself; the rest of
the shell keeps working.

The full authoring guide is `.ai/skills/companion-external-module/SKILL.md`, and
`pnpm sdk:surface` prints the ABI and fails on a breaking change.

## Permissions and roles

Every capability is a permission declared by the module that owns it, in that
module's `src/api/acl.ts`. That file is the single authored source: the
manifest's `permissions` array and the contract's `PermissionRegistry` are
derived from it.

```sh
pnpm acl add code repos:archive --title "Archive repositories" --grant admin
pnpm acl sync            # re-derive after editing acl.ts by hand
pnpm acl check           # the CI gate
```

`pnpm acl check` fails on: drift between the three declaration sites; a
permission id, WS message tag, `ServiceMap` key, route or nav key/shortcut
claimed by two modules; a permission gated on but declared nowhere; a grant
naming a permission its module does not own; an id that is not
`<resource>:<verb>`; and any change to the effective grid not mirrored in
`docs/acl-grid.json`, so "this PR changes who may do what" shows up in review.

Roles are **instance data**. `admin`, `maintainer` and `business` are seeded and
cannot be deleted, but what they hold is tunable, and you can add your own:

```sh
companion role list
companion role create release-manager --title "Release Manager" --from maintainer
companion role revoke maintainer prs:act      # maintainers may no longer merge
companion role reset  maintainer prs:act      # back to whatever the modules grant
companion acl explain maintainer prs:act      # why, naming the mechanism
```

The **Roles** admin page does the same thing with switches. Modules only ever
grant to the three built-ins, so adding a role never requires a module change.

If you lock yourself out, stop the daemon and run:

```sh
companion role repair --grant-admin <username>
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
