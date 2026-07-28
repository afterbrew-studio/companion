# Installing and running Companion

Three ways to run it, in order of how quickly they get you to a login screen.
Configuration for all of them is in [`configuration.md`](configuration.md).

## Prerequisites

- Node.js 22 or newer.
- Git.
- Optional for agent runs: the moxxy CLI (`npm i -g @moxxy/cli`). The daemon
  starts without it, but agent runs fail until it is installed.
- Optional for the Docker path: Docker and Docker Compose.
- Only for building from source: pnpm 10 (`corepack enable`).

## npx

The published CLI contains both the daemon and the built SPA.

```sh
npx @moxxy/companion
```

On first launch, choose an admin username, email and password, or press Enter
for local defaults. The generated password is shown once. Later launches reuse
`~/.companion`, start Companion at <http://127.0.0.1:8901> and open a browser
without repeating setup.

If the GitHub CLI is already authenticated, setup offers to connect its active
`github.com` identity as a personal GitHub account owned by the new admin. The
token is read from `gh` only after you confirm, sent to the local API, and never
printed or copied into the CLI configuration.

`npx @moxxy/companion init` does setup without starting the server. `--no-open`,
`--port` and `--home` do what they sound like.

This path is always the `slim` module set. The registry is compiled into the
published bundle, so picking a different one means Docker or a source build. See
[`development.md`](development.md#build-profiles-what-ships).

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

## Docker

The image runs the same bundle as the npx package: the build stage compiles the
workspace, the runtime stage carries only `dist/` plus four runtime
dependencies.

```sh
cp .env.example .env      # change the default password before exposing the port
docker compose up --build
```

Then open <http://127.0.0.1:8901>.

Data lives in the named volume `companion-data` at `/data`: the SQLite database,
cloned repositories and worktrees, the isolated moxxy home, and daemon config.

```sh
docker compose up -d --build        # background
docker compose logs -f companion    # follow logs
docker compose down                 # stop
docker compose down -v              # stop and delete all persisted data
```

The module set is a **build argument**:

```sh
docker build --build-arg PROFILE=slim -t companion:slim .   # default
COMPANION_PROFILE=full docker compose up -d --build
```

The image installs `@moxxy/cli` globally so agent runs can start inside the
container. If your repositories need SSH, mount an SSH configuration and key in,
and check the key's GitHub permissions.

## Coolify

The image is self-contained (daemon, built SPA, git, moxxy CLI) and ships a
`HEALTHCHECK` against the unauthenticated `/healthz` endpoint, so Coolify can
gate deploys on it. Point Coolify at the repository; either build pack works.

- **Dockerfile**: port `8901`, persistent storage at `/data` **and** at
  `/root/.moxxy`. The second holds the AI provider credentials, and without it
  every redeploy loses them.
- **Docker Compose**: uses `docker-compose.yml` as is, which already declares
  both volumes.

Set environment variables (admin credentials, `COMPANION_HOST=0.0.0.0`) in
Coolify's UI; they take precedence over any `.env`. Set `COMPANION_PUBLIC_URL`
to your domain so SSO and webhooks have an address to come back to.

### Redeploys must stop the old container first

If a redeploy fails with:

```
another Companion daemon is already using /data (pid 1 on <container>),
and it kept heartbeating for 75s, so it is still running.
```

the deployment is doing a **rolling update**, and that cannot work here. Turn it
off in the application's settings, so Coolify stops the old container before
starting the new one.

The reason is a genuine deadlock rather than a race. The new container waits for
the data directory, so it never becomes healthy. A rolling update will not stop
the old container until the new one is healthy. The old one is healthy, holds
`/data`, and keeps writing its heartbeat. Neither side can move, and the same
old container id shows up in every attempt. Waiting longer does not help; it only
stretches the deadlock until the healthcheck gives up.

Companion is single-node **because of the filesystem**, not the database. The
home holds clones, worktrees, scratch space, run configs and the isolated moxxy
home. Two daemons sharing it would both run every scheduled job and both check
out the same worktrees, and the damage would be silent. So the second one
refuses instead.

Once the setting is changed, clear the stuck container by hand, because a
correct strategy still has to get past the one already running:

```sh
docker ps --filter name=<your-app> --format '{{.ID}} {{.Status}}'
docker stop <old-container-id>
```

Then redeploy. If you need zero downtime, that is active/passive with a second
`COMPANION_HOME`, not two daemons on one volume.

### Deploying the full module set

**The profile is a build argument, not a runtime variable.** Setting
`COMPANION_PROFILE=full` as an ordinary environment variable changes nothing: by
the time the container starts, the module set is already compiled in. In Coolify,
mark it as a **build variable** (the per-variable toggle), or set the build arg
directly.

- **Dockerfile build pack**: build arg `PROFILE=full`.
- **Docker Compose build pack**: `COMPANION_PROFILE=full` marked as a build
  variable, which `docker-compose.yml` forwards to the same build arg.

Confirm it in the **build log**, not on the running instance. That one line
separates three things that look identical from outside:

| In the build log | What it means |
|---|---|
| `profile 'full': 13 module(s)` | The build was right. If the app still shows five, a stale container is running. |
| `profile 'slim': 5 module(s)` | The build argument never arrived. |
| no `profile '...'` line at all | Docker reused a cached layer, which also proves the argument never changed: a real change from `slim` to `full` invalidates that layer. |

The last two mean the same thing, and rebuilding without cache will not fix
them: the variable is not reaching the build. Switching to the **Docker Compose**
build pack is the reliable way out, since the compose file maps
`COMPANION_PROFILE` to the build argument itself.

A `full` build still boots with only the slim five enabled. The rest ship as
**Available** and an admin adopts them: see
[`operating-modules.md`](operating-modules.md#turning-on-everything-a-full-build-contains).

### Model providers in a container

The image ships the moxxy CLI, but a fresh container has no provider
credentials: there is no `~/.moxxy` to import from and `moxxy init` has never
run. Two ways out.

- **Exec in once.** `docker exec -it <container> sh`, then run moxxy's own
  login with the home pinned into the persistent volume:
  `MOXXY_HOME=/data/moxxy-home moxxy init`. Credentials survive redeploys
  because they live in `/data`. An API-key provider is the right choice on a
  server; OAuth credentials rotate their refresh token on every use and should
  not be shared across machines.
- **Skip local execution.** Leave the container provider-less as a pure control
  plane (UI, GitHub sync, orchestration) and attach [runners](runners.md) that
  already have moxxy configured.

## From source, without Docker

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter companion-api start
```

After `pnpm build`, the daemon serves the built SPA from `apps/web/dist` when
present.

### Under pm2

`ecosystem.config.cjs` runs the whole suite, daemon plus local runner, as a
managed process:

```sh
npm i -g pm2
pnpm prod                 # pnpm -r build && pm2 startOrRestart ecosystem.config.cjs
pm2 logs companion
pm2 save && pm2 startup   # survive reboots
```

Configuration comes from the daemon's layered environment
(`process env > ./.env > ~/.companion/.env`), so no pm2-specific settings are
needed. The file also has a commented-out entry for serving a `companion-runner`
agent from the same checkout.
