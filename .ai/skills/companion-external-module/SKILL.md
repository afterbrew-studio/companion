---
name: companion-external-module
description: >-
  Author, build, verify, and install an out-of-tree Companion module: one that
  lives outside this repo (a private enterprise module, a customer-specific
  module, or a third-party plugin) and is loaded by a running daemon from
  $COMPANION_HOME/modules instead of being compiled in. Covers the two-package
  ABI and why augmentation cannot go through the SDK, the moxxy block and install
  layout, `module verify`, the generated ABI bridge and the browser import map
  that keep the SDK and React singletons, and what the type system stops
  guaranteeing. Use when a module must not live in modules/*,
  or when working on the loading mechanism itself. In-tree modules use
  companion-build-module instead.
---

# Out-of-tree modules

**Status: BUILT and verified end to end, both halves.** A module with routes,
services, migrations, permissions, jobs, config, nav entries and pages can be
published, installed into `$COMPANION_HOME/modules/<id>/` and loaded by a running
daemon. The browser half was verified in a real browser: the module's nav entry
and page render, its `request()` calls carry the host's session, and the console
is clean.

`docs/modular-distribution.md` §6 is the design; this skill is the built shape.

An out-of-tree module is still the expensive option. Prefer:

- Put it in `modules/*` and use a **build profile** to keep it out of the OSS
  artifact (doc §3). This covers the entire OSS/Enterprise split and costs
  nothing new.
- Reach for out-of-tree only when the code genuinely cannot be compiled in: a
  customer's private module, a third-party plugin, or install without redeploy.

## Why this is expensive (understand before proposing it)

An in-tree module is compiled by the same `tsc` and the same Vite as the host, so
`react`, `@companion/core`, `zod` and friends are automatically one instance and
the declaration-merged registries are automatically complete. An out-of-tree
module gets neither for free. Everything below exists to buy those two
properties back.

## The ABI: two packages, and why it is not one

```
@moxxy/companion-sdk        everything you import
  .          defineManifest, manifest + config types, Permission / ServiceMap /
             SpaServerMessage / AuthUser, Role, SDK_VERSION, ABI_GENERATION
  /server    defineApiModule, defineAcl, defineMigrations, defineRoutes,
             defineRawRoutes, defineJobs, route(), rawRoute(), Reply,
             redirect / document / created / accepted, HttpError,
             notFound / badRequest / forbidden, ModuleContext, Migration,
             AuditSink, SecretStore, RbacReader, paths, log, likeArg, safeParse
  /client    defineClientModule, defineNav, defineSections, defineClientRoutes,
             defineSlots, defineOnboarding, lazyView, page, useLive, Slot,
             request / post / put / patch / del, NavIcon, OnboardingArt
  /ui        the presentational kit (wildcard re-export of @companion/ui)
  /agents    AskRequest, MoxxyEvent, HistorySegment, PromptAttachment,
             extractModelJson

@moxxy/companion-contracts           ONE line: the registry augmentation target
```

The second package is not an oversight. **TypeScript binds declaration merging
to the module that DECLARES an interface.** Augmenting a package that merely
re-exports it creates a second, unrelated interface, so the permission is
silently absent from `Permission`. Measured: `declare module '<facade>'` gives
TS2820 on the augmented key, `declare module '<declaring package>'` compiles.
So a module's `contract` slice writes:

```ts
declare module '@moxxy/companion-contracts' {
  interface PermissionRegistry { 'widgets:manage': true }
}
```

and everything else comes from the SDK. Declare both as **devDependencies +
peerDependencies, never dependencies** (see the singleton section: an installed
copy is the failure mode, not the fix).

The surface is pinned in `packages/sdk/surface.json` and CI fails on drift
(`pnpm sdk:surface`). Anything not in it is host machinery and is unreachable on
purpose: `ModuleKernel`, `DynamicRouter`, `MigrationRunner`, `ServiceRegistry`,
`RbacGrid`, `WsHub`, `ModuleConfigStore` and the runner wire protocol.

## Package layout

Publish built output only. `package.json` carries a `moxxy` block, read as data
before anything is imported:

```json
{
  "name": "companion-module-hello",
  "version": "1.2.0",
  "type": "module",
  "moxxy": {
    "id": "hello",
    "abi": "0.x",
    "manifest": "./dist/module.js",
    "api": "./dist/api.js",
    "client": "./dist/client.js"
  }
}
```

`moxxy.id` must equal the directory name it installs into, so one module cannot
shadow another. `abi` is a **generation**, not a semver range: while the SDK is
pre-1.0 every minor may break, and a caret range would let a 0.1 module load into
0.4 and fail somewhere deep instead of at boot. Omit `client` for a server-only
module, which is the only kind that works today.

Install is a directory: `$COMPANION_HOME/modules/<id>/` containing
`package.json` and `dist/`. **No `node_modules`.** The daemon scans it at boot,
reports each rejected directory with a reason, and keeps the good ones.

## Verify before you install

`companion module verify <dir>` runs against files, with no daemon. It checks the
`moxxy` block, the ABI generation, that the entry files exist, that the built
chunk's static imports are a subset of the allowed ABI specifiers, and that no
ABI package is vendored or listed as a runtime dependency. Run it in the
module's own CI.

## The allowed-import rule

A built external module may statically import **only**:

server: `@moxxy/companion-sdk/*`, `better-sqlite3`, `zod`, `ws`, node builtins
client: `@moxxy/companion-sdk/*`, `react`, `react/jsx-runtime`, `react-dom`

Everything else must be bundled into the module's own artifact. `companion
module verify <path>` parses the built ESM's static import list and fails on
anything outside the allowlist. Run it before publishing; it is the check that
catches the entire class of shared-singleton bugs mechanically instead of at
2am in a customer's browser console.

The failure mode it prevents on the client is **a second React instance**: hooks
throw, and context resolves to defaults silently, which is worse.

## How the singletons are resolved

**Server: a generated ABI bridge, not a symlink.** A symlink cannot work: in a
published build the daemon is one esbuild bundle, so there is no unbundled SDK on
disk to point at. Instead the daemon publishes its live namespace objects on
`globalThis[Symbol.for('companion.abi')]` and writes a tiny package next to the
modules:

```
$COMPANION_HOME/modules/
  node_modules/@moxxy/companion-sdk/   generated at every boot
    index.js  server.js  agents.js        `export const X = abi["X"]`
  <id>/
    package.json                          NO node_modules
    dist/api.js
```

Node's ordinary upward lookup finds it from any module directory, and every
import resolves to the objects the host is already using. The re-export list is
the daemon's own namespace keys, so an unlisted symbol is unreachable rather than
merely undocumented, and the bridge cannot promise something the running build
does not have.

**The failure this prevents is silent, and was measured.** Give a module its own
copy of the SDK and it gets its own `Reply` class. The router decides what to
send with `result instanceof Reply`, so `redirect('/board')` comes back as
**HTTP 200 with the body `{"status":302,...}`** and a `text/plain` reply comes
back as JSON. No error, no warning, nothing in the log. With the bridge: 302.

So the daemon **refuses at scan time** any module directory containing
`node_modules/@moxxy-ai`, and `module verify` refuses an ABI package listed as a
runtime dependency. This is the whole class, killed mechanically.

**Client: an import map in the host `index.html`.** Six specifiers resolve to
`/host/*.js`, which are entry points of the SAME Vite build as the app, so
Rollup puts React in a chunk both share. They are unhashed on purpose: a module
compiled months ago cannot know this release's chunk hashes. `ModulesProvider`
then imports `/modules/<id>/client.js?v=<version>` for any enabled module the
build has no compiled-in loader for.

```
react, react/jsx-runtime, react-dom,
@moxxy/companion-sdk, @moxxy/companion-sdk/client, @moxxy/companion-sdk/ui
```

That list is exactly what a client chunk may import; `pnpm sdk:surface` diffs
the import map against `module verify`'s allowlist so the two cannot drift.

**Build for production.** There is no `react/jsx-dev-runtime` entry, so a dev
build fails to resolve rather than dragging React's development runtime into a
production page. `createRoot` is absent too: the host owns the root, and a
module mounting a second one detaches itself from the app's context and live
state.

A missing or wrong import map fails **loudly** (`Failed to resolve module
specifier "react"`, logged against the module id) and only that module drops
out; the rest of the shell renders. That is the whole reason the map is the
mechanism rather than bundling React into the chunk, which would fail silently
from inside a hook.

## Build shape

The module is bundled by its own toolchain, with the ABI marked external so it
resolves to the host's copy at load time:

```js
// esbuild
external: ['@moxxy/companion-sdk', '@moxxy/companion-sdk/*',
           'better-sqlite3', 'zod', 'ws']            // server
external: ['@moxxy/companion-sdk/client', '@moxxy/companion-sdk/ui',
           'react', 'react/jsx-runtime', 'react-dom'] // client
```

```
dist/module.js   the manifest, imported eagerly at boot (keep it cheap)
dist/api.js      the server slice
dist/client.js   the client slice, when the browser half exists
```

Everything else about the module is unchanged: same `define*` registrants, same
`ModuleContext`, same migrations, same ACL threading, same broadcast discipline.
`modules/README.md` remains the authoring reference. **This skill only changes
how the code is compiled and delivered, never how it is written.**

A worked example, verified against a live daemon: an out-of-tree module that
declares `hello:read`, runs a migration, serves three routes and reads its own
config, built entirely outside the repo with only the SDK and
`@moxxy/companion-contracts` linked in. Its permission entered the live RBAC grid, its
migration ran, and `redirect()` returned a real 302.

## What the type system stops guaranteeing## What the type system stops guaranteeing

The registries (`PermissionRegistry`, `ServerMessageRegistry`, `ServiceMap`,
bus events) are declaration merges that close over **one compilation**. An
external module augments them in its own compilation and gets full safety for
its own ids. The host never sees them.

Consequences, all of which are review-blocking:

- Use `ctx.services.tryGet(...)` across every boundary into the host or another
  module. Never `get`. The host may be a version that does not have that service.
- Never assume a permission or service exists because its type resolved.
- Pin the host version you support via a manifest field and check it at load
  time. A module built against SDK 2.x loaded into a 1.x daemon should refuse to
  enable with a clear message, not fail halfway through `onEnable`.
- Host and shell code must never exhaustively switch over a module-owned union.
  If you are touching `packages/*` or `apps/*` while doing this work and you add
  such a switch, you have made the open module set impossible.

## Trust, stated plainly

External modules run **in-process** with `ctx.db`, the service registry, and full
filesystem access. There is no sandbox. Do not write documentation, UI copy, or
comments that imply there is one.

`companion module install` therefore takes signed / first-party packages by
default and requires `--allow-untrusted` for anything else, with a one-sentence
prompt saying what that means. Manifests may declare capabilities for display
and review; declaration is documentation, not enforcement, and the UI should say
so.

## Checklist

- [ ] The in-tree + build-profile option was considered and explicitly rejected.
- [ ] The client chunk is built for **production** with react, react/jsx-runtime
      and the SDK subpaths external.
- [ ] SDK and `@moxxy/companion-contracts` are dev + peer dependencies, never runtime
      ones, and the published tarball has no `node_modules`.
- [ ] Registry augmentation targets `@moxxy/companion-contracts`, not the SDK.
- [ ] `companion module verify` passes: no import outside the allowlist.
- [ ] Every foreign boundary uses `tryGet` / `ctx.bus`, never `get`.
- [ ] `moxxy.abi` matches the daemon's generation and `moxxy.id` matches the
      install directory.
- [ ] `onDisable` releases everything `onEnable` claimed. A leaked timer in an
      external module is a leak nobody can find from the host's source.
- [ ] Migrations are additive and idempotent, with a `down()` or a `purge(db)`.
      `remove` must leave the database clean.
