---
name: companion-build-module
description: >-
  Build or extend a Companion feature module in the modular framework — the
  Next.js-style convention files (manifest, contract, api slice, client slice),
  the define* registrants, runtime lifecycle (enable/disable/uninstall), open
  RBAC/WS/service registries, single-owner tables, and wiring into the two app
  registries. Use for "add a new <domain>", "add a feature to <module>", or any
  work under modules/*. Supersedes companion-add-backend-area / companion-add-web-area,
  which describe the pre-modular layered spine that no longer exists.
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
4. **Thread RBAC completely** (manifest `permissions` + `acl` `permissions`&`grants`
   + `contract` `PermissionRegistry` + route `access` + nav/route `permission`).
   A half-threaded permission is a bug.
5. **Broadcast every mutation** (`ctx.broadcast({ t: '<id>.changed' })`) and
   consume it in exactly one client hook via `useLive`.
6. **Install** = one entry in `apps/api/src/modules.ts` (manifest + contract
   import + `MODULES` load thunk) and one in `apps/web/src/modules.ts`
   (`CLIENT_LOADERS`). `pnpm install` links it.
7. **Verify** (see below). Note what you could not verify by running.

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

## Verify

- `pnpm -r build && pnpm -r typecheck` clean (the typecheck is the primary gate;
  fix every unhandled union member / DTO drift it flags).
- Boot `pnpm dev` and drive the module: its nav/routes appear and its API returns
  200; **disable** it (Modules admin) → nav/routes vanish, API 503s, permissions
  drop from the grid; **enable** → restored; **uninstall** → `down()` runs, paths
  404; restart → toggle state durable.

## What you return

The module/feature built, files grouped by slice (contract / api / client /
registries), the permission(s) threaded, the two `modules.ts` edits, the
build+typecheck result, and an explicit list of what you verified by running vs.
what still needs manual driving.
