# Building a Companion module

Companion is a **modular framework**. Every feature domain — identity, workspaces,
code, planning, execution, automations, admin — is a self-contained package under
`modules/*`, loaded, migrated, permissioned, and toggled **at runtime** by the
kernel in `@companion/core`. This document is the complete system for authoring
one. Read it before adding or changing a module.

> New here? The fastest way to learn the shape is to read one existing module
> end-to-end. **`modules/plan`** is the canonical full-stack example (tables,
> services, routes, a client with nav/pages/hooks, cross-module deps). **`modules/admin`**
> is the minimal example (no tables, reads other modules via the registry).

---

## 1. The mental model

A module is a package named `@companion/module-<id>` that exposes **four entry
points** through its `package.json` `exports` map:

| Subpath | Resolver | Loaded | Purpose |
|---|---|---|---|
| `./manifest` | node/tsc (`dist`) | eagerly, at boot | the cheap **metafile** — id, dependsOn, required, declared permissions/messages. The kernel reads every module's manifest to build the dependency graph and answer `GET /api/modules` **without loading any module's code**. |
| `./contract` | node + Vite (`source`) | eagerly (types only) | DTOs crossing the HTTP/WS boundary **and** the `declare module` augmentations that open the shared registries (permissions, WS messages, services, bus events). Types are erased at runtime. |
| `./api` | node/tsc (`dist`) | **lazily**, only when enabled | the server slice — acl, migrations, services, routes, raw routes, jobs. Never imported by the browser; compiled with **no DOM/JSX**. |
| `./client` | Vite (`source`) | **lazily**, only when enabled | the web slice — nav, routes, pages, hooks, slots, onboarding. Vite code-splits it into one chunk per module; a disabled module's chunk is never fetched. |

The **dual resolver** is the central constraint: `./api` is compiled by
NodeNext `tsc` to `dist/` with no DOM, while `./client` is read by Vite straight
from `.tsx` **source** (via the `"source"` export condition). This is why the
files live under `src/api` / `src/client` / `src/contract` — subfolder by
consumer — and why an `api/*` file importing React (or a `client/*` file
importing `better-sqlite3`) is a **build error**, not a runtime surprise. That
error IS the server/client boundary being enforced.

Each convention file **default-exports** through a `@companion/core` `define*`
helper (Next.js-style). The helpers are identity functions typed to their
interface — they exist for authoring-site type-checking and discoverability,
nothing more.

---

## 2. Anatomy

```
modules/<id>/
  package.json            # the exports map (dual resolver) + workspace deps
  tsconfig.json           # typecheck-all view: bundler + customConditions:["source"] + DOM/JSX, noEmit
  tsconfig.build.json     # the /api build: NodeNext, EMITS dist, lib ES2022 only, EXCLUDES src/client
  src/
    module.ts             # defineManifest({...})              ← the metafile (./manifest). No heavy imports.
    contract/index.ts     # DTO slice + `declare module` augmentations   (./contract)
    api/                                                        # the ./api barrel + its parts (server, no DOM)
      acl.ts              # defineAcl({ permissions, grants })
      migrations.ts       # defineMigrations([{ version, name, up, down? }])
      services.ts         # defineServices((ctx) => { ctx.services.register('<id>', new XService(...)) })
      routes.ts           # defineRoutes((ctx) => [ route({...}) ])
      raw-routes.ts       # defineRawRoutes((ctx) => [ rawRoute({...}) ])   (optional — webhooks)
      jobs.ts             # defineJobs({ jobs?, onEnable?, onDisable?, postActivate? })  (optional)
      <domain>-store.ts   # SQLite store(s): row types + prepared statements (owner of this module's tables)
      <domain>-service.ts # the domain service registered on ServiceMap
      index.ts            # defineApiModule({ manifest, acl, migrations, registerServices, routes, rawRoutes?, lifecycle? })
    client/                                                     # the ./client barrel + its parts (web, source)
      nav.tsx             # defineNav([...]) + defineSections([...])
      routes.tsx          # defineClientRoutes([{ match, permission, component }])
      pages/*.tsx         # page components (lazy-loaded → per-page Vite chunks)
      hooks/*.ts          # useLive-based data hooks
      api.ts              # the api slice: <id>Api = {...} using request/post from @companion/core/client
      slots.tsx           # defineSlots([...])           (optional — render INTO another module's page)
      onboarding.tsx      # defineOnboarding([...])      (optional — this module's welcome-tour step)
      index.tsx           # defineClientModule({ manifest, sections, nav, routes, slots?, onboarding? })
```

Only `module.ts`, `contract/index.ts`, and the two barrels (`api/index.ts`,
`client/index.tsx`) are mandatory. Everything else is present only if the module
needs it (a module with no tables omits `migrations.ts`; a read-only admin
surface omits `services.ts`).

---

## 3. package.json + tsconfig (copy these verbatim)

`package.json` — the `exports` map is the load-bearing part. `./api` has **no**
`source` condition (Vite must never pull server code); `./client` has **only**
`source` (it's never built to `dist`).

```jsonc
{
  "name": "@companion/module-<id>",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "exports": {
    "./manifest": { "types": "./dist/module.d.ts", "default": "./dist/module.js" },
    "./contract": { "source": "./src/contract/index.ts", "types": "./dist/contract/index.d.ts", "default": "./dist/contract/index.js" },
    "./api":      { "types": "./dist/api/index.d.ts", "default": "./dist/api/index.js" },
    "./client":   { "source": "./src/client/index.tsx" }
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "dev": "tsc -p tsconfig.build.json --watch --preserveWatchOutput",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@companion/core": "workspace:*",
    "@companion/contracts": "workspace:*",
    "@companion/services": "workspace:*",
    "@companion/types": "workspace:*",
    "@companion/ui": "workspace:*",
    "zod": "^3.24.0"
    // + one "@companion/module-<dep>": "workspace:*" per module in your dependsOn
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.12", "@types/node": "^22.10.0", "@types/react": "^18.3.12",
    "better-sqlite3": "^12.2.0", "react": "^18.3.1", "typescript": "^5.8.0"
  },
  "sideEffects": false
}
```

`sideEffects: false` lets Vite tree-shake unused client exports — keep it, and
never rely on import side effects in client code except the one contract import
(see §5).

`tsconfig.build.json` (the `./api` emit — **excludes `src/client`**, so DOM/JSX
can't leak into the server build):

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src", "lib": ["ES2022"], "types": ["node"] },
  "include": ["src/module.ts", "src/contract", "src/api"],
  "exclude": ["src/client"]
}
```

`tsconfig.json` (the typecheck-all view — bundler resolution + the `"source"`
condition + DOM/JSX, `noEmit`):

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true, "module": "ESNext", "moduleResolution": "bundler",
    "customConditions": ["source"], "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"], "types": ["node"]
  },
  "include": ["src"]
}
```

---

## 4. The metafile — `src/module.ts`

Cheap, statically imported by both apps. **No heavy imports** here (it must not
pull in your services or pages).

```ts
import { defineManifest } from '@companion/core';

export default defineManifest({
  id: 'widgets',                          // the module id — used everywhere (ServiceMap key, nav section, routes)
  title: 'Widgets',
  version: '0.1.0',
  dependsOn: ['workspace', 'core'],       // hard load/enable order — an owner must be enabled first
  required: false,                        // true ⇒ can never be disabled (only core + workspace are required)
  permissions: ['widgets:read', 'widgets:manage'],   // declared for GET /api/modules; enforced by acl.ts
  messages: ['widgets.changed'],          // WS message types this module broadcasts
});
```

`dependsOn` is the **hard** graph: the kernel topo-sorts by it and refuses to
enable a module whose dependency is disabled (409), or to disable one that an
enabled module depends on (409). Cross-domain **reactions** (reacting to another
module's event) are **soft** — do them via `ctx.bus` / `ctx.services.tryGet`, not
`dependsOn`, so they don't create load-order cycles.

---

## 5. The contract slice — `src/contract/index.ts`

Two jobs: (1) declare the DTOs that cross HTTP/WS, and (2) **open the shared
registries** for your module by augmenting the interfaces in `@companion/contracts`
and `@companion/core`.

```ts
// Import the contract of every module you depend on, so its augmentations are
// visible in this compilation (types only — erased at runtime).
import '@companion/module-workspace/contract';
import '@companion/module-core/contract';
import type { WidgetService } from '../api/widget-service.js';

declare module '@companion/contracts' {
  interface PermissionRegistry {          // open the RBAC union
    'widgets:read': true;
    'widgets:manage': true;
  }
  interface ServerMessageRegistry {       // open the WS message union: 't' → payload
    'widgets.changed': Record<never, never>;      // no payload
    // 'widget.updated': { widget: WidgetRecord }; // with payload
  }
  interface ServiceMap {                  // publish your service for ctx.services.get('widgets')
    widgets: WidgetService;
  }
}

export interface WidgetRecord {           // DTOs are readonly
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly createdAt: number;
}
```

The registries are **declaration-merged open unions**. Because `apps/api` and
`apps/web` import *every* module's contract (see their `modules.ts`), the unions
resolve to the full installed set and exhaustive `switch (msg.t)` still
type-checks. **Compile-checked shape, runtime-checked presence**: a permission or
service exists in the *type* whether or not its module is enabled, so always go
through `ctx.rbac`/`ctx.services.get` across a `dependsOn` edge (or `tryGet` for a
soft dep) — never assume presence from the type.

> Every `client/` file that participates in the tour of a module's types must see
> these augmentations. The client barrel (`client/index.tsx`) does
> `import '../contract/index.js'` as its **first** line for exactly this reason —
> keep it.

---

## 6. The API slice (`src/api/*`)

Each factory receives the **`ModuleContext`** (`ctx`) — the typed replacement for
the old god-object. The pieces you get:

| `ctx.` | What |
|---|---|
| `db` | the shared better-sqlite3 handle (WAL). Your store owns its tables; read others' via `services`, not raw SQL. |
| `services` | the typed `ServiceRegistry`: `register(id, impl)`, `get('code')`, `tryGet('operate')`. Keys are `ServiceMap`. |
| `bus` | typed server-side pub/sub for cross-module **reactions** (`bus.emit('run.changed', run)` / `bus.on(...)`). |
| `broadcast(msg)` / `pushToUser(name, msg)` | browser push over the WebSocket hub. |
| `notify` | the shared notification emitter (`ctx.notify.emit({...})`). |
| `settings` | namespaced key/value over the core-owned `settings` table. |
| `rbac` | the live effective RBAC grid reader (`ctx.rbac.has(role, perm)`). |
| `ws` | the WS scope-resolver registry — register per-message visibility in `onEnable`. |
| `modules` / `isEnabled` | kernel lifecycle control + enabled-checks. |
| `db`, `log`, `config`, `fts` | handle, logger, daemon config, and probed FTS5 availability. |

### acl.ts — permissions + role grants

```ts
import { defineAcl } from '@companion/core/server';
import '../contract/index.js';   // so the permission ids type-check

export default defineAcl({
  permissions: [
    { id: 'widgets:read', title: 'View widgets' },
    { id: 'widgets:manage', title: 'Create and edit widgets' },
  ],
  grants: {
    admin: '*',                              // '*' = every permission this module declares
    maintainer: ['widgets:read', 'widgets:manage'],
    business: ['widgets:read'],
  },
});
```

The runtime `ROLE_PERMISSIONS` grid is **assembled at boot from the enabled
modules' grants**. Disabling a module drops its permissions from the grid
immediately (its routes 503, the client `can()` hides its UI on next fetch).

### migrations.ts — tables, with rollback

```ts
import { defineMigrations } from '@companion/core/server';

export default defineMigrations([
  {
    version: 1,
    name: 'widgets_init',
    // v1 = idempotent adopt: CREATE TABLE IF NOT EXISTS (+ try/catch ALTER for
    // additive columns). No-op against a live DB, full schema against a fresh one.
    up: (db, env) => {
      db.exec(`CREATE TABLE IF NOT EXISTS widgets (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL
      );`);
      // env.fts.available → conditionally create FTS5 tables, keep a LIKE fallback.
    },
    // no down() ⇒ irreversible (uninstall must purge() instead). Provide down()
    // for reversibility: (db) => db.exec(`DROP TABLE IF EXISTS widgets`).
  },
  // v2+ are real, once-only, numbered migrations — no try/catch — each with a down().
]);
```

`disable` keeps data; `uninstall` walks `down()` to 0 (or calls the module's
`purge(db)` if any step is irreversible) and clears the migration ledger.

### services.ts — construct + register

```ts
import { defineServices } from '@companion/core/server';
import { WidgetStore } from './widget-store.js';
import { WidgetService } from './widget-service.js';

export default defineServices((ctx) => {
  const store = new WidgetStore(ctx.db);
  // Resolve dependencies through the registry (they're registered before you —
  // topo order). Capture lazily if you need the live instance later.
  const workspace = ctx.services.get('workspace');
  ctx.services.register('widgets', new WidgetService(store, workspace, ctx.notify));
});
```

### routes.ts — typed, RBAC-enforced HTTP

```ts
import { z } from 'zod';
import { defineRoutes, route, created, notFound } from '@companion/core/server';

export default defineRoutes((ctx) => {
  const widgets = ctx.services.get('widgets');
  return [
    route({
      method: 'GET', path: '/api/widgets', access: 'widgets:read',
      handler: ({ user }) => ({ widgets: widgets.listFor(user!) }),
    }),
    route({
      method: 'POST', path: '/api/widgets', access: 'widgets:manage',
      body: z.object({ name: z.string().min(1).max(80) }),
      handler: ({ body, user }) => {
        const w = widgets.create(user!, body.name);
        ctx.broadcast({ t: 'widgets.changed' });   // broadcast every mutation
        return created({ widget: w });
      },
    }),
  ];
});
```

`access` is `'public'` | `'any'` (signed-in) | a `Permission`. The router
enforces it centrally — **a route cannot forget auth**. Path params are inferred
from the pattern at the type level; matching is whole-segment (no ordering
hazard). Throw `notFound`/`badRequest`/`forbidden` (they status-map); a foreign
error becomes a logged 500, so an upstream 401 can never masquerade as a session
denial.

### raw-routes.ts — webhooks (optional)

For endpoints that must read **exact bytes** and authenticate themselves (a
webhook whose HMAC is computed over the raw body — no bearer, no JSON parse):

```ts
import { defineRawRoutes, rawRoute } from '@companion/core/server';

export default defineRawRoutes((ctx) => {
  const svc = ctx.services.get('widgets');
  return [
    rawRoute({
      method: 'POST', path: '/webhooks/widgets/:id',
      handler: ({ params, headers, body }) => svc.handleDelivery(params.id, headers, body),
      //  → returns { status, body, contentType? }
    }),
  ];
});
```

Raw routes mount/unmount with the module exactly like normal routes (disabled
owner → 503, uninstalled → 404). They bypass RBAC by design — keep them rare.

### jobs.ts — lifecycle hooks + background work (optional)

```ts
import { defineJobs } from '@companion/core/server';

export default defineJobs({
  onEnable: (ctx) => { /* subscribe ctx.bus, register ctx.ws scope resolvers */ },
  onDisable: async (ctx) => { /* unsubscribe, unregister, shut services down cleanly */ },
  postActivate: (ctx) => { /* resumers/recovery — runs ONCE after every module's onEnable */ },
  jobs: [{ id: 'widgets.sweep', everyMs: 300_000, run: (ctx) => { /* ... */ } }],
});
```

`onDisable` must fully release what `onEnable` claimed (bus subscriptions, WS
resolvers, sockets, timers) — a leak here survives a disable.

### index.ts — the `/api` barrel

```ts
import { defineApiModule } from '@companion/core/server';
import manifest from '../module.js';
import acl from './acl.js';
import migrations from './migrations.js';
import registerServices from './services.js';
import routes from './routes.js';
import rawRoutes from './raw-routes.js';   // omit if none
import lifecycle from './jobs.js';          // omit if none

export default defineApiModule({ manifest, acl, migrations, registerServices, routes, rawRoutes, lifecycle });
```

---

## 7. The client slice (`src/client/*`)

The web host (`ModulesProvider` / `useKernel`) fetches `GET /api/modules`,
dynamic-imports each enabled module's `/client`, and aggregates their
contributions. The shell **presents** them — RBAC-filtering nav/routes by the
live `can()`. Data hooks use `useLive(refresh, when)` over the single WebSocket.

### nav.tsx — sidebar

```tsx
import { defineNav, defineSections, NavIcon } from '@companion/core/client';

export const sections = defineSections([{ id: 'widgets', label: 'Widgets', order: 45 }]);
export const nav = defineNav([
  {
    key: 'widgets', label: 'Widgets', hash: '#/widgets', shortcut: 'w',
    permission: 'widgets:read', section: 'widgets', order: 0,
    icon: <NavIcon><path d="M4 7h16M4 12h16M4 17h10" /></NavIcon>,   // shared frame + stroke
    // freshOn?: (msg) => string | null   // nav "new activity" badge
  },
]);
```

### routes.tsx — pages

```tsx
import { defineClientRoutes, lazyView } from '@companion/core/client';

export const routes = defineClientRoutes([
  { match: { exact: '/widgets' }, permission: 'widgets:read', component: lazyView(() => import('./pages/Widgets.js')) },
  // whole-segment matching: { exact }, { prefix }, or { regex, params }
]);
```

Use `lazyView`/`page` from `@companion/core/client` so each page is its own Vite
chunk (with stale-chunk reload handling built in).

### api.ts — the fetch slice

```ts
import { request, post } from '@companion/core/client';
import type { WidgetRecord } from '../contract/index.js';

export const widgetsApi = {
  list: () => request<{ widgets: WidgetRecord[] }>('/api/widgets'),
  create: (name: string) => post<{ widget: WidgetRecord }>('/api/widgets', { name }),
};
```

### slots.tsx / onboarding.tsx (optional)

`defineSlots` renders your component **into another module's page** (inversion of
control — e.g. an "AI Review" tab on the PR page without `code` importing
`operate`). `defineOnboarding` contributes one welcome-tour step for your feature,
gated on **your own** permission and framed by the shared `OnboardingArt`:

```tsx
import { defineOnboarding, OnboardingArt } from '@companion/core/client';
export const onboarding = defineOnboarding([{
  key: 'widgets', order: 45, need: 'widgets:read',
  title: 'Widgets', body: '…', chips: ['Sidebar → Widgets'],
  art: (playing) => <OnboardingArt>{/* svg */}</OnboardingArt>,
}]);
```

### index.tsx — the `/client` barrel

```tsx
import { defineClientModule } from '@companion/core/client';
import '../contract/index.js';                    // MUST be first — carries the augmentations
import manifest from '../module.js';
import { nav, sections } from './nav.js';
import { routes } from './routes.js';
import { onboarding } from './onboarding.js';     // omit if none

// Re-export anything the shell / other modules reach by name:
export { widgetsApi } from './api.js';

export default defineClientModule({ manifest, sections, nav, routes, onboarding });
```

---

## 8. Ownership rules (one DB, no ORM police)

The engine can't stop a foreign JOIN, so ownership is by convention and enforced
by review:

- **One owner per table.** Writes go only through the owning module's service.
  Reads default to the owner's service via the registry
  (`ctx.services.get('code').repos.getRecord(full)`), never raw cross-table SQL.
- For a genuinely hot cross-module JOIN, the owner **publishes a read-only view**
  `v_<thing>` in its migration that consumers may JOIN (e.g. code publishes
  `v_repos(full_name, workspace_id)`; workspace scopes against it).
- Every row filters on **workspace** for access scoping — resolve visibility
  through `ctx.services.get('workspace').canAccess*`.

---

## 9. Installing the module (wire it into the two apps)

A new module is **one line in each app registry** + a rebuild. This is the only
place the apps name a module:

- `apps/api/src/modules.ts` — add the manifest import, the `import '.../contract'`
  line, and one `{ manifest, load: () => import('@companion/module-<id>/api').then(m => m.default) }`
  entry to `MODULES`.
- `apps/web/src/modules.ts` — add `<id>: () => import('@companion/module-<id>/client')`
  to `CLIENT_LOADERS`.
- `pnpm-workspace.yaml` already globs `modules/*`, so `pnpm install` links it.

The kernel reconciles the new module into the `modules` table on next boot
(installed + enabled by default) and activates it in dependency order. No other
edits — there is no central route table, no `App.tsx` if-ladder, no `ApiDeps`.

---

## 10. Recipe — add a module from scratch

1. `mkdir -p modules/<id>/src/{api,client,contract}` and copy `package.json` +
   both `tsconfig`s from §3 (change the name/deps).
2. Write `src/module.ts` (manifest — §4) and `src/contract/index.ts` (DTOs +
   augmentations — §5).
3. API slice (§6): `acl.ts`, `migrations.ts` (if it owns tables), a store +
   service, `services.ts`, `routes.ts`, optional `raw-routes.ts`/`jobs.ts`, then
   `api/index.ts`.
4. Client slice (§7): `nav.tsx`, `routes.tsx`, `pages/*`, `hooks/*`, `api.ts`,
   optional `slots.tsx`/`onboarding.tsx`, then `client/index.tsx`.
5. Register in both `modules.ts` files (§9); `pnpm install`.
6. `pnpm -r build && pnpm -r typecheck` until green.
7. Boot (`pnpm dev`) and verify with the checklist below.

---

## 11. Checklist & gotchas

- [ ] **Thread the permission completely**: in the manifest `permissions`, in
      `acl.ts` (`permissions` + `grants`), in `contract` (`PermissionRegistry`),
      on each route `access`, on nav `permission`, and on client route `permission`.
      A half-threaded permission is a bug.
- [ ] **Broadcast every mutation** (`ctx.broadcast({ t: '<id>.changed' })`) and
      consume it in exactly one client hook via `useLive`.
- [ ] Relative imports end in **`.js`** (NodeNext), even from `.ts`/`.tsx`.
- [ ] `client/index.tsx` imports `'../contract/index.js'` **first**.
- [ ] No React/DOM in `src/api/*`; no `better-sqlite3`/node built-ins in
      `src/client/*`. The `tsconfig.build.json` exclude + `tsconfig.json` DOM libs
      are what catch this.
- [ ] Migrations are **additive & idempotent** (v1) and carry a `down()` (v2+) or
      the module defines `purge(db)`.
- [ ] Cross-module access goes through `ctx.services.get(dep)` (hard dep) or
      `tryGet`/`ctx.bus` (soft reaction) — never a raw foreign JOIN, never assume
      a service/permission is present from its type.
- [ ] `onDisable` releases everything `onEnable` claimed (bus, ws, timers, sockets).
- [ ] Don't add an npm dependency without justifying it — reach for the platform
      and `@companion/ui` first.

**Verify at runtime** (`pnpm dev`, then via the Modules admin page or the API):
enable/disable your module — its nav/routes appear/vanish and its API flips
between 200 and 503; the RBAC grid gains/loses its permissions; `uninstall` runs
its `down()` migrations and its paths become 404; a restart keeps the toggle
state durable.

---

## 12. Where the framework lives

| Package | Role |
|---|---|
| `@companion/types` | inert primitives, zero runtime — DAG root. |
| `@companion/contracts` | the open registries (RBAC/WS/services/bus) + RBAC assembler + envelopes. |
| `@companion/services` | base store/service abstractions + shared utils (paths, log, request-context). |
| `@companion/core` | **the framework** — `.` (isomorphic `define*` + manifest), `/server` (kernel, routers, migrations, service registry, bus, ws hub, capabilities), `/client` (ModulesProvider, route compiler, net/WS, `useLive`, `NavIcon`, `OnboardingArt`, `lazyView`). |
| `@companion/ui` | the presentational kit (design system, Markdown, DiffView, icons). |

The kernel's lifecycle, the dynamic + raw routers, and the registrant API are the
public surface you build against; read `packages/core/src/server/kernel.ts` and
`packages/core/src/client/index.tsx` when you need the exact contract.
