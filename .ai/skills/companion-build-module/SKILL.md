---
name: companion-build-module
description: >-
  Build or extend a Companion feature module in the modular framework — the
  Next.js-style convention files (manifest, contract, api slice, client slice),
  the define* registrants, runtime lifecycle (enable/disable/uninstall), open
  RBAC/WS/service registries, single-owner tables, the `pnpm acl` tooling that
  threads a permission, the `shell.*` slots a module uses to reach the app shell,
  and adding the module to a build profile. Use for "add a new <domain>", "add a
  feature to <module>", or any work under modules/*. Supersedes
  companion-add-backend-area / companion-add-web-area, which describe the
  pre-modular layered spine that no longer exists.
---

# Build a Companion module

Companion is a **modular framework**: every domain is a package under `modules/*`
named `@companion/module-<id>`, loaded / migrated / permissioned / toggled at
runtime by the kernel in `@companion/core`. You extend it by adding or growing a
module — never by inventing a parallel structure.

## Source of truth — read it first

**`modules/README.md`** is the complete authoring system (anatomy, the exact
`package.json`/`tsconfig` pair, every `define*` registrant including
`defineRawRoutes`/`defineOnboarding`, `ModuleContext`, lifecycle, ownership
rules, the install recipe, and a checklist). Read it before writing code. This
skill is the operating procedure; the README is the reference.

Then read the nearest existing module and **match it**:
- **`modules/plan`** — the canonical full-stack module (tables, migrations,
  services, routes, a client with nav/pages/hooks, four cross-module deps).
- **`modules/admin`** — the minimal module (no tables; reads other modules via
  the service registry).
- **`modules/automations`** — soft cross-module reactions via `ctx.bus`, plus a
  `raw-routes.ts` webhook receiver.

## The shape (what you produce)

A module has four entry points via its `package.json` `exports`: `./manifest`
(cheap metafile, eager), `./contract` (DTOs + registry augmentations, types
only), `./api` (server slice, lazy, **no DOM**), `./client` (web slice, lazy,
Vite source). The dual resolver — tsc→`dist` for `./api`, Vite `source` for
`./client` — is enforced by `tsconfig.build.json` excluding `src/client`. Put
files under `src/api` / `src/client` / `src/contract`; each convention file
default-exports through a `define*` helper.

## How you work

1. **Restate the module/feature** and list the files you'll touch across the
   slices: `module.ts` → `contract/` → api (`acl`, `migrations`, `store`,
   `service`, `services`, `routes`, opt. `raw-routes`/`jobs`, `index`) → client
   (`nav`, `routes`, `pages`, `hooks`, `api`, opt. `slots`/`onboarding`, `index`).
   Confirm scope: new module, or an api-only / client-only change to an existing one.
2. **Pick `dependsOn` deliberately.** Hard deps = topo load order (owner enabled
   first). Cross-domain *reactions* are **soft** — `ctx.bus`/`ctx.services.tryGet`,
   NOT `dependsOn` — or you create a load-order cycle.
3. **Build the contract first**, then the api slice top-down, then the client
   slice. Resolve other modules through `ctx.services.get(dep)` (hard) or
   `tryGet` (soft) — never a raw foreign JOIN; own your tables, read others'
   through their service or a published `v_*` view.
4. **Add permissions with the tool, never by hand.** `acl.ts` is the single
   authored source; the manifest array and the contract's `PermissionRegistry`
   are derived from it:

   ```sh
   pnpm acl add <module> <resource>:<verb> --title "..." [--grant admin,maintainer]
   pnpm acl sync     # after editing acl.ts directly
   ```

   Then gate: route `access`, nav `permission`, client route `permission`.
   Grants are keyed by **built-in role only**; custom roles are composed by the
   instance and are none of your module's business.
5. **Broadcast every mutation** (`ctx.broadcast({ t: '<id>.changed' })`) and
   consume it in exactly one client hook via `useLive`.
6. **Install** = add the id to `profiles/full.json` (and `slim.json` only if it
   belongs in the default build). `pnpm install` links it and regenerates the
   registries; you never edit those by hand.
7. **Verify** (see below). Note what you could not verify by running.

## Reaching the app shell

The shell (`apps/web/src/App.tsx`) imports **only** `required: true` modules
(core, workspace). Yours is not one, so you never add an import there: contribute
to a `shell.*` slot instead, and a build without your module simply renders
nothing.

| Slot | Renders |
|---|---|
| `shell.banner` | full-width notice above the page (operate: runner capacity) |
| `shell.topbar` | the status cluster right of the search box (operate: run queue, agent status; automations: AI Help) |
| `shell.effects` | components that return `null` and exist to run a shell-level effect (code: workspace-scoping the nav freshness badges) |

A slot contribution carries its own `permission`, so it is RBAC-filtered like
nav. State that two contributions share must live in ONE component: splitting a
button and its panel across two slots pushes their shared state back into the
shell, which is the thing being avoided.

`NavEntry.home` (lowest wins) claims the landing page for a bare URL. Declare it
only if your module genuinely owns the front page; the shell falls back to the
first entry the role can reach.

## Cross-module reactions on the client

Server-side you use `ctx.services.tryGet` / `ctx.bus`. The client twin is
`isMessage(msg, 'other.changed')` from `@companion/core/client`: the tag is not
in your compilation's `SpaServerMessage` union because you do not import that
module's contract, and with the owner absent the reaction simply never fires.
Use it for a refresh or a badge, never to gate behaviour.

If you gate UI on a permission another module owns, declare it in the manifest's
`consumes` and make sure the UI degrades when `can()` goes false, because that
permission leaves the grid whenever its module is disabled. `pnpm acl check`
warns about any undeclared use.

## Hard rules

- Relative imports end in **`.js`** (NodeNext), even from `.ts`/`.tsx`.
- `src/api/*` never imports React/DOM; `src/client/*` never imports
  `better-sqlite3`/node built-ins. `client/index.tsx` imports `'../contract/index.js'`
  **first** (augmentation visibility).
- Migrations are **additive & idempotent** (v1: `CREATE TABLE IF NOT EXISTS` +
  try/catch `ALTER`); v2+ are numbered, once-only, and carry `down()` (or the
  module defines `purge(db)`). `disable` keeps data; `uninstall` runs `down()`.
- **Compile-checked shape, runtime-checked presence**: a permission/service is in
  the type union whether or not its module is enabled — always go through
  `ctx.rbac`/`ctx.services.get`(dep)/`tryGet`(soft), never assume presence.
- `onDisable` must release everything `onEnable` claimed (bus subs, ws resolvers,
  timers, sockets). Keep `sideEffects: false`.
- Reuse `@companion/ui` and the existing `define*`/store/service patterns. Do not
  hand-roll a router, modal, ORM, or auth check, and don't add an npm dependency
  without justifying it.
- Stay in scope. If the task needs a genuinely new framework mechanism (not just
  a new module), stop and surface the design choice with a recommendation.

## Which edition, and how it ships

This skill covers writing the module. For **where it lives (OSS vs Enterprise),
whether it ships by default, build profiles, and the CLI/Docker delivery path**,
use `companion-editions-and-distribution`. For a module that must live outside
this repo, use `companion-external-module`. For the enterprise bar on auth,
RBAC, audit, secrets and air-gap, use `companion-enterprise-readiness`.

## Verify

- `pnpm build && pnpm typecheck && pnpm acl check` clean. `acl check` is a real
  gate, not a formality: it fails on declaration drift, an id claimed by two
  modules (permission, WS tag, `ServiceMap` key, route, nav key **or nav
  shortcut**), a permission gated on but declared nowhere, a grant naming a
  permission your module does not own, an id that is not `<resource>:<verb>`, an
  undeclared foreign permission, a shell import of a non-required module, and any
  change to the effective grid not mirrored in `docs/acl-grid.json`.
- If your module is not in the default build, check the profile that contains it:
  `pnpm gen:modules --profile full && pnpm -r build`. `minimal` (core + workspace)
  is the guard that the shell stayed module-free.
- `pnpm -r build && pnpm -r typecheck` clean (the typecheck is the primary gate;
  fix every unhandled union member / DTO drift it flags).
- Boot `pnpm dev` and drive the module: its nav/routes appear and its API returns
  200; **disable** it (Modules admin) → nav/routes vanish, API 503s, permissions
  drop from the grid; **enable** → restored; **uninstall** → `down()` runs, paths
  404; restart → toggle state durable.

## What you return

The module/feature built, files grouped by slice (contract / api / client), the
permission(s) threaded and how (`pnpm acl add` vs hand-edited), the profile
entry, the `build` + `typecheck` + `acl check` result, and an explicit list of
what you verified by running vs. what still needs manual driving.

Driving it for real is cheap and worth doing: boot a throwaway daemon on an
isolated home and port so you never touch the developer's own instance.

```sh
COMPANION_HOME=/tmp/probe COMPANION_PORT=8977 COMPANION_LOG_LEVEL=warn \
COMPANION_ADMIN_USER=admin COMPANION_ADMIN_PASSWORD='Test-Pass-12345' \
  node apps/companion-cli/dist/server.js &
companion module install <id> --home /tmp/probe --port 8977
companion acl explain admin <id>:read --home /tmp/probe --port 8977
```

Then kill it and delete the directory.
