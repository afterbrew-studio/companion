# Companion

A maintainer's GUI that plugs into a GitHub repository and manages it end-to-end —
browse and triage issues, spawn [moxxy](https://github.com/moxxy-ai/moxxy) agents to
fix them, open PRs, run AI-analyzed proposals, and automate via webhooks and schedules.

## How it relates to moxxy

moxxy is an **external runtime**, not a dependency. Companion has zero `@moxxy/*`
packages in its tree; it requires an installed moxxy CLI (`npm i -g @moxxy/cli`) and
drives it over the moxxy gateway wire protocol (WebSocket JSON-RPC, bearer token).

Every agent run is its own `moxxy mobile --standalone` process under a **separate
`MOXXY_HOME`** (`~/.companion/moxxy-home`), so Companion sessions never appear in
your daily moxxy desktop/TUI/CLI.

## Layout

- `apps/companiond` — local daemon: run orchestration, gateway pool, GitHub sync, SQLite store, HTTP+WS server
- `apps/web` — React SPA served by companiond (Vite in dev)
- `packages/contract` — shared types (REST DTOs, gateway wire subset, run states)

## Development

```sh
pnpm install
pnpm dev          # companiond on :8901 + Vite on :5173 (proxies /api and /ws)
```
