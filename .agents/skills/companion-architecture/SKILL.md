---
name: companion-architecture
description: >-
  Map of the Companion modular-framework monorepo and its load-bearing
  invariants. Read this BEFORE any nontrivial change so you edit the right layer
  and don't break a cross-cutting rule. Use when you need to know where something
  lives, how a request flows contract → store → service → route → api → hook →
  page inside a module, how modules load/toggle at runtime, or what must never be
  violated (end-to-end RBAC, single-owner tables, GitHub-as-cache, live broadcasts).
---

# Companion architecture

Companion drives GitHub repositories with [moxxy](https://github.com/moxxy-ai/moxxy)
agents. It is a **pnpm workspace monorepo**, all ESM, all TypeScript `strict`,
structured as a **modular framework**: a small framework core hosts feature
**modules** that load, migrate, permission, and toggle **at runtime**.

> To build or extend a module, the authoritative guide is **`modules/README.md`**
> and the **`companion-build-module`** skill. This skill is the map; that one is
> the recipe.

## The layout

```
apps/
  api/                  the daemon: kernel boot + the module registry + HTTP/WS server
  web/                  the React/Vite SPA shell: ModulesProvider + net layer (no feature code)
  companion-runner/     the published @moxxy/companion-runner (remote execution agent)
packages/
  types/       @companion/types      inert primitives, zero runtime — DAG root
  contracts/   @moxxy/companion-contracts  the OPEN registries (RBAC/WS/services/bus) + grid assembler + envelopes
  services/    @companion/services   base store/service abstractions + shared utils (paths, log, request-context)
  core/        @companion/core        THE FRAMEWORK: registrant API + server kernel + client host
  ui/          @companion/ui          the design-system kit
modules/
  core workspace operate code plan automations admin   ← one @companion/module-<id> per domain
```

`@companion/core` (the framework: kernel + registrants, no business logic) is
distinct from `@companion/module-core` (the required identity module). `moxxy` is
an **external runtime, not a dependency** — the daemon shells out to the `moxxy`
CLI. Never add moxxy as a package dep.

## Packages (the framework)

| Package | What it is | Depends on |
|---|---|---|
| `@companion/types` | naked primitives (branded ids, enums, moxxy wire types). No runtime, no boundary meaning. | — |
| `@moxxy/companion-contracts` | cross-boundary machinery: the declaration-merged open registries `PermissionRegistry` / `ServerMessageRegistry` / `ServiceMap` / bus events, the RBAC grid assembler, `AuthUser`/route-access/error envelopes. | types |
| `@companion/services` | what a single store/service is made of — `BaseStore` helpers, request-context, `paths`, `log`, config. Kernel-independent. | types, contracts |
| `@companion/core` | the framework host. `.` = isomorphic `define*` + manifest; `/server` = kernel + lifecycle, `DynamicRouter` + `RawRouter`, `MigrationRunner`, `ServiceRegistry`, `ServerBus`, `WsHub`, capabilities; `/client` = `ModulesProvider`/`useKernel`, route compiler, single-socket net + `useLive`, `NavIcon`/`OnboardingArt`/`lazyView`. | types, contracts, services |
| `@companion/ui` | presentational React + Tailwind (Markdown, DiffView, icons). Pixels only. | react (+ types) |

## Modules (the domains)

Each `modules/<id>` is a package with four entry points via its `package.json`
`exports`: `./manifest` (cheap metafile, eager), `./contract` (DTOs + registry
augmentations, types only), `./api` (server slice, lazy, no DOM), `./client`
(web slice, lazy, Vite source). Dual resolver: tsc→`dist` for `./api`, Vite
`source` for `./client`; `tsconfig.build.json` excludes `src/client`. See
`modules/README.md` §1–2.

```
core → workspace → operate → code → plan       required = {core, workspace}
                          \→ admin              (dependsOn = hard load/enable order)
```

## The request spine (learn this cold)

A feature is one vertical slice **inside a module**. Same shape as ever, but the
registries replaced the central files (no `buildRoutes`, no `ApiDeps`, no
`App.tsx` route ladder):

```
modules/<id>/src/contract/index.ts   ← DTOs + `declare module` augment RBAC/WS/ServiceMap   (shared truth)
        │
        api/<x>-store.ts             ← SQLite class + prepared SQL           (owns this module's tables)
        api/migrations.ts            ← defineMigrations — tables, with down()  (per-module, versioned)
        api/<x>-service.ts           ← business logic; ctx.broadcast on change  (behavior)
        api/services.ts              ← defineServices — construct + ctx.services.register('<id>', svc)
        api/routes.ts                ← defineRoutes — route({ access: Permission })  (HTTP surface)
        api/index.ts                 ← defineApiModule({ manifest, acl, migrations, services, routes, ... })
        ▼
        client/api.ts                ← request/post slice                     (client surface)
        client/hooks/use<X>.ts       ← useLive(refresh, msg.t === '<id>.changed')
        client/pages/<X>.tsx         ← page (ui.tsx kit), lazyView-chunked
        client/nav.tsx               ← defineNav — sidebar entry + permission + shortcut
        client/routes.tsx            ← defineClientRoutes — whole-segment match → page
        client/index.tsx             ← defineClientModule({ manifest, nav, routes, ... })
```

Installed via **one line in each app registry**: `apps/api/src/modules.ts`
(`MODULES`) and `apps/web/src/modules.ts` (`CLIENT_LOADERS`).

## Runtime lifecycle (what "modular" buys)

The kernel (`packages/core/src/server/kernel.ts`) reconciles the installed set
into a `modules` table, topo-sorts enabled modules by `dependsOn`, and for each:
`load()` → `migrateUp` → `registerServices` → mount routes → `onEnable` → a
single `postActivate` pass (resumers). Toggling is live: **enable** mounts
routes + folds ACL into the grid; **disable** unmounts (paths 503) + drops ACL +
runs `onDisable`, keeping data; **uninstall** runs `down()` migrations (or
`purge`), clears the ledger, and its paths become 404. State is durable across
restarts.

## Non-negotiable invariants

Break one and the change is wrong even if it typechecks.

1. **RBAC is enforced once, centrally.** Every route declares `access`
   (`Permission | 'public' | 'any'`); the router calls `auth.require`. Handlers
   never re-check. The runtime grid is assembled at boot from **enabled** modules'
   ACL grants — a permission exists in the type union whether or not its module is
   on. **Compile-checked shape, runtime-checked presence**: cross a `dependsOn`
   edge via `ctx.services.get`/`ctx.rbac` (or `tryGet` for a soft dep), never
   assume presence. See `companion-contract-and-rbac`.
2. **The contract slice is the single source of truth.** A type crossing the
   client/server boundary lives in that module's `contract/index.ts`; the
   registries are opened there by augmentation. Never redefine a DTO locally.
3. **Single-owner tables.** One module owns each table; writes go through its
   service, reads through the registry or a published `v_*` view — never a raw
   foreign JOIN. See `companion-store-and-migrations`.
4. **GitHub stays authoritative.** `issues`/`prs` (module-code) are a sync cache;
   only sync or an applied action mutates them.
5. **Mutations broadcast.** After a state change, `ctx.broadcast({ t: '<id>.changed' })`;
   the SPA is live over one socket, consumed by one `useLive` hook.
6. **Cross-module reactions are soft.** React to another domain's event via
   `ctx.bus` / `ctx.services.tryGet`, never a new `dependsOn` edge that would
   create a load-order cycle.
7. **ESM import suffix.** Relative imports end in `.js` even from `.ts`/`.tsx`.
   See `companion-code-standards`.

## Build, run, verify

```sh
pnpm install            # corepack enable first; pnpm 10, Node >= 20
pnpm dev                # companion-api + Vite (proxies /api,/ws)
pnpm -r build           # tsc across packages/modules (+ vite build for web, esbuild for the runner)
pnpm -r typecheck       # THE quality gate — no linter, no test suite yet
```

The bar is: `pnpm -r typecheck` clean and code that reads like its neighbours.
Because modules link via `workspace:*` and all contracts are imported by both
apps, a registry change shows up on both sides — run the root typecheck.

## When you're about to…

- **Add or extend a module** → `modules/README.md` + `companion-build-module`.
- **Add/relax a permission or a DTO** → `companion-contract-and-rbac`.
- **Touch the database** → `companion-store-and-migrations`.
- **Write any code** → `companion-code-standards` (mechanics) + `craft-principles`.
- **Reason about cost / review** → `performance-and-complexity`, `critical-thinking`.
