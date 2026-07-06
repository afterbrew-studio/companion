# Companion

A self-hosted engineering dashboard that plugs into GitHub and manages repositories
end-to-end with [moxxy](https://github.com/moxxy-ai/moxxy) agents — triage issues,
review pull requests (CI-aware), run user-defined PR pipelines, implement proposals
into PRs, and automate via webhooks and schedules.

## The platform

Everything is scoped to a **workspace** (a named group of repos). Three main areas
per workspace — **Proposals**, **Issues**, **Pull Requests** — plus Pipelines,
Agent Runs, Automations, Repositories, and Settings. Areas are registered as
modules (one entry in `apps/web/src/modules.tsx`, one route file in
`apps/companiond/src/http/routes/`), so future integrations slot in without
touching the shell.

- **Auth + RBAC** — login screen backed by `.env` credentials (see `.env.example`).
  Three roles: `admin` (everything), `maintainer` (day-to-day operation),
  `business` (proposals only). Every REST route declares the permission it
  requires; the SPA renders only the modules the signed-in role can use.
- **Pipelines** — user-defined, per-workspace pipelines composed of typed steps
  (CI checks gate, AI review, custom agent, labels, comment) plus a **custom step
  library** of reusable steps. Pipelines run against any PR manually or
  automatically when a PR opens (webhook).
- **CI awareness** — GitHub check runs + commit statuses are folded into one
  status per PR, shown across the UI, and injected into every reviewing agent's
  context; the PR gate never auto-approves a PR with failing pipelines.
- **Metrics** — per-workspace counters and weekly opened-vs-closed velocity for
  issues and PRs on the Overview dashboard.
- **Agents** — every run defaults to the `gpt-5.5` model (override with
  `COMPANION_MODEL`).

Keyboard shortcuts: `g` + a key jumps between modules, `/` focuses search,
`?` shows the cheatsheet.

## How it relates to moxxy

moxxy is an **external runtime**, not a dependency. Companion has zero `@moxxy/*`
packages in its tree; it requires an installed moxxy CLI (`npm i -g @moxxy/cli`) and
drives it over the moxxy gateway wire protocol (WebSocket JSON-RPC, bearer token).

Every agent run is its own `moxxy serve` + gateway process pair under a **separate
`MOXXY_HOME`** (`~/.companion/moxxy-home`), so Companion sessions never appear in
your daily moxxy desktop/TUI/CLI.

## Layout

- `apps/companiond` — local daemon: typed route registry + RBAC, auth sessions,
  run orchestration, gateway pool, GitHub sync + checks, pipeline engine,
  SQLite store, HTTP+WS server
- `apps/web` — React SPA served by companiond (Vite in dev): login, dashboard
  shell, module registry, workspace switcher
- `packages/contract` — shared types (domain records, RBAC permission grid,
  pipeline step unions, REST DTOs, gateway wire subset)

## Development

```sh
pnpm install
cp .env.example .env   # set admin/maintainer/business credentials
pnpm dev               # companiond on :8901 + Vite on :5173 (proxies /api and /ws)
```

Without a `.env`, the daemon generates an admin credential into
`~/.companion/.env` on first boot and logs where it put it.
