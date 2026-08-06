# Companion: OSS + Enterprise distribution architecture

Status: **most of this is now built.** The document was written as a design and
kept as the reasoning behind what shipped; `docs/game-plan.md` records what
happened, including the places where building it changed the design.

| Section | State |
|---|---|
| §3 slim by default | **built**: `autoInstall: false` on the seven optional modules |
| §4 generated registries | **built**: `profiles/*.json` + `pnpm gen:modules`, automatic on install/dev/build/typecheck |
| §5 module-free shell | **built**: `shell.*` slots; `acl check` enforces it |
| §7 entitlement gate | **built**; the OSS/Enterprise repo split is still a plan |
| §9 invariants | **built** as checks in `pnpm acl check` |
| §12 build and Docker | **built**: one bundle, three delivery vehicles |
| §6 the ABI | **built**: `@moxxy/companion-sdk` is published, the bridge resolves it to the host |
| §8 CLI surface | **built**, with `add` split from `install` (see the section for why) |
| §14 install lifecycle | **not built**, and deliberately so (see §15) |

Tags below mean: `[NOW]` exists, `[NEXT]` additive and unbuilt, `[LATER]` needs a
new mechanism, `[NO]` deliberately rejected.

Companion is already a modular framework (see `modules/README.md`). This document
is only about the layer above it: **who can ship a module, how it reaches a
running instance, and which artifact contains it.**

---

## 1. Where we actually stand `[NOW]`

Facts, measured, not assumed:

- 15 modules under `modules/*`, including the read-only Workbench composition
  layer over the existing domain services.
- The kernel (`packages/core/src/server/kernel.ts`) already reconciles an
  installed set into a `modules` table, topo-sorts by `dependsOn`, and does
  live enable / disable / install / uninstall with migrations and RBAC
  recomputation. **Runtime module lifecycle is done.**
- Server `/api` slices are already lazy (`load()` thunks). Client `/client`
  slices are already lazy (one Vite chunk per module, never fetched when
  disabled). **Lazy loading is done.**
- `GET /api/modules` plus `POST /api/modules/:id/{install,enable,disable,uninstall}`
  and `PUT /api/modules/:id/config` already exist in `modules/core/src/api/routes.ts`.
  **The CLI has a server to talk to.**
- The set of modules is closed at build time by two files (now generated from a
  profile, see §4).
- Two modules are `required: true`: `core` and `workspace`.

So the gap is **not** "make modules dynamic". Modules are dynamic. The gap is
**"make the set open"**, and that is a much narrower, much more expensive
problem than it looks from the outside. The rest of this document is mostly
about not paying that price before it buys something.

### The findings that shape everything below

**Finding 1 (FIXED in P5): the shell was not module-agnostic.** `apps/web/src/App.tsx` (983
lines) statically imports from three modules:

```
import { WorkspaceProvider, useWorkspace, Inbox, workspaceApi } from '@companion/module-workspace/client';
import { RunnerCapacityBanner, RunQueueIndicator, operateApi } from '@companion/module-operate/client';
import { useWorkspaceRepos } from '@companion/module-code/client';
```

and it names module-owned strings directly: `msg.t === 'issues.changed'`,
`'prs.changed'`, `'repos.changed'`, `can('issues:read')` for the default landing
route. The `slots` mechanism exists and is used for in-page contributions
(operate, slop, playground), **but the shell itself exposes no slots.**

Consequence: any build profile that dropped `code` or `operate` failed to
compile, and the slim artifact shipped automations' AI Help even though the
module could never be enabled there. Fixed with the machinery that already
existed: `shell.banner` / `shell.topbar` / `shell.effects` slots, `NavEntry.home`
for the landing page, and `registerFreshFilter` for the one piece of scoping a
module had to own. `acl check` now fails on a shell import of a non-required
module, so it cannot come back one convenient import at a time.

**Finding 2: nothing exhaustively switches on a module-owned union.** Every
consumer of `SpaServerMessage` uses equality predicates (`useLive(refresh, (msg)
=> msg.t === 'board.changed')`). That is lucky and load-bearing: it means an
**open** message set stays type-safe. Keep it that way (see §9).

**Finding 3: `Role` is a closed union.** `packages/types/src/roles.ts` is
`'admin' | 'maintainer' | 'business'`. Enterprise buyers ask for custom roles
within the first two calls. This is a core change, not a module.

**Finding 4 (FIXED in P0): naming was inconsistent.** `apps/companion-cli/package.json`
declares `"name": "@moxxy/companion"`, its own `--help` text says
`npx @moxxy/companion`, and the `Dockerfile` installs `@moxxy/cli`. Pick one
scope and fix it before anything is published under it.

---

## 2. The pivotal decision: do you need out-of-tree modules?

Two distribution models, and it is worth being blunt about the cost difference.

**Model A: compile-time editions.** Enterprise modules live in a private repo,
are added to the registries at build time, and produce a *different artifact*
(`companion-enterprise` image). No ABI, no runtime resolution, no plugin
sandbox, full end-to-end type safety across the declaration-merged registries.
This is what GitLab and Sentry do.

**Model B: runtime-installable modules.** Prebuilt module artifacts land in
`$COMPANION_HOME/modules/` and are loaded by a running daemon. This is what VS
Code and Grafana do. It needs a published, versioned ABI on **both** sides
(Node and browser), a shared-singleton strategy, artifact verification, and a
trust story.

The honest position: **Model A buys the entire OSS/Enterprise split.** Model B
buys a *plugin ecosystem*, and only that. If the near-term goal is "sell an
enterprise edition", Model B is not on the critical path and building it first
will cost a month and add permanent surface area.

**Recommendation:** ship Model A now, keep every intermediate decision
Model-B-compatible, and implement Model B when there is a second party actually
writing a module (a customer, a partner, or a private customer-specific module
that must not go in your repo). The concrete "keep it compatible" moves are:
generate the registries (§4), introduce the SDK facade (§6), and make the kernel
accept module *sources* rather than a hardcoded array.

---

## 3. Slim by default: two mechanisms, and only one of them needs a build `[NOW]`

The goal ("ship a lighter Companion by default: core, workspace, operate, code,
admin") has two separable meanings, and they have wildly different costs.

**Meaning 1: a lighter product experience.** A new instance should not open onto
eleven sidebar sections. This needs **no build work at all.** The kernel already
supports `autoInstall: false`, which lands a compiled-in module as "Available"
on the Modules page instead of installing it. Set it on `plan`, `planner`,
`board`, `refinement`, `slop`, `playground`, `automations` and you are done. A
disabled module's client chunk is never fetched, so the runtime cost is already
zero.

Do this first. It is a one-line change per module and it delivers most of the
value.

**Meaning 2: a smaller artifact, and an OSS tarball that does not physically
contain enterprise code.** This genuinely needs build profiles, because
"available but not installed" still ships the bytes.

So: **`autoInstall` for the product experience, build profiles for the
distribution boundary.** Do not conflate them.

Note the dependency closure when picking profiles: `refinement` depends on
`plan` + `board`; `planner` depends on `plan` + `board` + `refinement`;
`automations` depends on `plan`. The optional modules are one connected
planning cluster, not seven independent choices. There are effectively three
tiers, not eleven.

| Profile | Modules | Artifact |
|---|---|---|
| `slim` | core, workspace, operate, code, workbench, admin, plan, board, automations | `@moxxy/companion` (npx), `companion:oss` image |
| `full` | slim + refinement, planner, slop, playground, notify, oidc | `@moxxy/companion-full`, `companion:full` image |
| `enterprise` | slim + enterprise modules | `companion:enterprise` image only |

The `slim` set is exactly the shell's hard-import closure (Finding 1), which is
why it compiles today and the others would not without §5.

---

## 4. Generated registries and the module map `[NOW]`

Replace the two hand-maintained files with generated ones.

```
profiles/slim.json         { "name": "slim", "modules": ["core","workspace","operate","code","admin","plan","board","automations"] }
profiles/full.json
profiles/enterprise.json   (lives in the private repo, or is composed from an env var)

scripts/gen-modules.mjs --profile slim
  -> apps/api/src/modules.generated.ts      (gitignored)
  -> apps/web/src/modules.generated.ts      (gitignored)
```

The generator must **fail the build** when the selected set is not closed under
`dependsOn`, and when a `required: true` module is absent. That check is worth
more than the codegen itself: it turns a runtime 409 into a build error.

`apps/api/src/index.ts` and `apps/web/src/App.tsx` import the generated file. The
committed `modules.ts` files disappear. A missing generated file should print
`run: pnpm gen:modules --profile slim`, not a module-resolution stack trace.

### On generating a map into `.companion/modules`

Partly right, with one important correction. **Split it in two:**

- The **builtin** set is a property of the *build artifact*, not of the data
  directory. Writing it into `$COMPANION_HOME` means a downgrade or an image
  swap leaves a stale map claiming modules the binary no longer contains. Keep
  it compiled in (`modules.generated.ts`).
- The **external** set is state, and belongs in the data directory:

```
$COMPANION_HOME/
  companion.db
  modules/
    registry.json                 # written only by the CLI / daemon
    node_modules/                 # symlinks to the daemon's shared ABI packages
    <id>/
      package.json
      node_modules/               # the module's own private deps
      dist/module.js              # manifest
      dist/api/index.js           # server slice (Node ESM)
      dist/client/index.js        # browser slice (prebuilt ESM, NOT source)
```

The kernel takes the **union** of the two as its `InstalledModule[]`, tagging
each with `source: 'builtin' | 'external'`. That is the whole change on the
kernel side: `KernelOptions.modules` stops being a literal and becomes the
result of a resolver.

The `node_modules/` symlink farm one level above the modules is the trick that
makes shared singletons work on the server with zero loader hooks: Node's
resolution walks upward from `<id>/dist/api/index.js`, misses `<id>/node_modules`,
and hits `modules/node_modules/@moxxy/companion-sdk`, which is a symlink to
the daemon's copy. Because Node resolves symlinks to their realpath by default,
identity is preserved and `instanceof HttpError` still works. Install external
module deps with `--omit=peer` so npm does not helpfully install a second SDK.

---

## 5. Making the shell module-free `[NOW]`

This is the highest-value refactor in this document, it uses only mechanisms
that already exist, and it is a prerequisite for any profile that is not a
superset of `slim`.

Add shell slots in `@moxxy/companion-core/client` and move each coupling out:

| Today in `App.tsx` | Becomes |
|---|---|
| `<RunnerCapacityBanner/>`, `<RunQueueIndicator/>` from operate | operate contributes to slots `shell.banner` / `shell.status` |
| `<Inbox/>`, workspace switcher from workspace | workspace stays (it is `required` and is the scoping primitive), but reached through `shell.*` slots, not a named import |
| `useWorkspaceRepos()` from code | code contributes the fresh-marking predicate; the shell reads only `NavEntry.freshOn` |
| `msg.t === 'issues.changed' \|\| 'prs.changed'` workspace-scoped fresh logic | a `freshOn` that can return a scope, resolved by the module that owns the message |
| `can('issues:read')` picking the bare-route landing page | a `home?: number` priority on `NavEntry`; the shell picks the highest-priority permitted entry |

Acceptance test for "the shell is module-free": `apps/web/src/App.tsx` contains
zero `@companion/module-*` imports and zero module-owned string literals. Until
that is true, "fully modular" is aspirational.

`workspace` and `core` being `required: true` means the shell may legitimately
depend on their *contract types*. Everything else goes through a slot.

---

## 6. The ABI: one SDK package `[BUILT; browser half still design]`

**Built, and two things about the design below turned out to be wrong.**
`@moxxy/companion-sdk` ships with 227 curated symbols across `.`, `/server`,
`/client`, `/ui` and `/agents`; ten in-tree feature modules import it. See
`docs/game-plan.md` P8 and P9 for what each part cost.

Correction 1: **there is no `/contracts` entry point.** TypeScript binds
declaration merging to the module that declares an interface, so augmenting the
façade silently creates a second `PermissionRegistry` (measured: TS2820).
`@moxxy/companion-contracts` stays the augmentation target and is part of the public
ABI.

Correction 2: **the server symlink farm below cannot work.** The daemon is one
esbuild bundle, so there is no unbundled SDK on disk to symlink to, and a second
copy gives a second `Reply` class: `redirect()` then returns HTTP 200 with the
body `{"status":302,...}`, silently. The daemon generates an ABI bridge package
instead, re-exporting its own live namespace objects.

The measurement that settled the "do it while there are only 12 modules"
argument still stands: in-tree modules imported 196 distinct symbols across seven
entry points, and the migration was a mechanical rewrite of import specifiers.
The same inventory is why the façade is genuine curation: eighteen of the 26
`@moxxy/companion-types` symbols are the runner wire protocol, and seventeen more host
symbols (`ModuleKernel`, `DynamicRouter`, `MigrationRunner`, …) are excluded by
name. `packages/sdk/surface.json` pins the list; `pnpm sdk:surface` is a CI gate.

The design as originally written follows.

Third parties and the private enterprise repo cannot compile against five
`private: true` workspace packages. Publish exactly one facade:

```
@moxxy/companion-sdk
  .          -> defineManifest, module types            (isomorphic)
  /server    -> defineApiModule, defineAcl, defineMigrations, defineRoutes,
                defineRawRoutes, defineJobs, route(), rawRoute(), HttpError,
                created/notFound/badRequest/forbidden, ModuleContext types
  /client    -> defineClientModule, defineNav, defineSections, defineClientRoutes,
                defineSlots, defineOnboarding, lazyView, useLive, request/post,
                NavIcon, OnboardingArt
  /ui        -> the @moxxy/companion-ui kit
  /contracts -> the open registries to augment
```

This is a public API boundary, not indirection for its own sake: it is the thing
you semver, and the thing whose export list you curate. **In-tree modules must
import it too.** An ABI that only external code uses rots within one release.
Mechanically this is a re-export package plus a codemod over `modules/*`; do it
once, early, while there are 12 modules and not 40.

### Browser side

External client slices ship **prebuilt ESM**, not source (Vite cannot compile a
package it did not know about at build time). Shared singletons come from an
import map emitted by the host `index.html`:

```html
<script type="importmap">
{ "imports": {
  "react": "/host/react.js",
  "react/jsx-runtime": "/host/jsx-runtime.js",
  "react-dom": "/host/react-dom.js",
  "@moxxy/companion-sdk/client": "/host/sdk-client.js",
  "@moxxy/companion-sdk/ui": "/host/sdk-ui.js"
} }
</script>
```

The host builds a `host-runtime` entry that re-exports those. External modules
build with exactly those specifiers marked external. `ModulesProvider` gains one
fallback: when `props.loaders[id]` is missing, `import(/* @vite-ignore */
'/modules/' + id + '/client.js?v=' + version)`.

**The failure mode to design against is a second React instance** (hooks throw,
context silently resolves to defaults). Do not trust authors to get this right.
`companion module verify` parses the built chunk's static import list and fails
if it is not a subset of the allowed ABI specifiers. That check is cheap,
mechanical, and catches the whole class.

### Server side

Same principle, enforced by the symlink farm in §4. Externals:
`@moxxy/companion-sdk/*`, `better-sqlite3`, `zod`, `ws`. A module never opens
the database; it receives `ctx.db`.

### Type-system consequence, stated plainly

The declaration-merging registries (`PermissionRegistry`, `ServerMessageRegistry`,
`ServiceMap`) close over **one compilation**. An external module augments them in
its own compilation and gets full safety for its own ids. The host does not see
them. Therefore:

- **Core and shell code must never exhaustively switch over a module-owned
  union.** Today they do not (Finding 2). Write this down as an invariant and
  enforce it in review, because the day it is violated is the day the open set
  becomes impossible.
- External modules use `ctx.services.tryGet(...)` across every foreign boundary,
  never `get`.
- Permissions are runtime strings assembled from `acl.ts`. That already works.

---

## 7. The OSS / Enterprise boundary `[LATER]`

### Repo layout

**Recommended: separate private repo**, `companion-enterprise`, publishing
`@moxxy/module-sso`, `@moxxy/module-audit`, etc. to a private registry,
consumed by the enterprise build profile.

Rejected `[NO]`: an `ee/` directory inside the OSS repo under a commercial
license. It works (Sentry, Cal.com) but it puts every OSS contributor one
directory away from code they may not use, complicates the license story of a
single `pnpm install`, and makes "the OSS tarball contains no enterprise code"
false by default.

Keep the OSS repo MIT (as it is today). The enterprise repo carries its own
commercial license. The SDK is published under the OSS license so anyone can
write modules.

### The manifest gains two fields

```ts
edition: 'oss' | 'enterprise',        // default 'oss'; informational, drives the UI badge
entitlement: 'sso' | 'audit' | ...,   // optional; the kernel refuses enable without it
```

### License enforcement, honestly

For a self-hosted, source-available product, license enforcement is a
**contractual control with a technical speed bump**, not a security boundary.
Anyone can patch the check out. Design for the honest customer and for audit,
not for the attacker:

- An Ed25519-signed license file at `$COMPANION_HOME/license.jwt` carrying
  `exp`, `seats`, `features[]`, `instanceId`. Public key baked into the build.
  **Offline-verifiable**, which is non-negotiable for air-gapped installs.
- Check **at enable time, and once per day**, never on a request path. The hot
  path must never learn what a license is.
- On expiry, **degrade, never brick**: the module goes read-only and the admin
  page shows a renewal banner. A product that bricks a customer's install at
  02:00 loses the renewal you were trying to protect.
- Log entitlement decisions to the audit trail. That is the artifact a customer
  procurement team actually wants.

### Trust for external modules, stated plainly

Modules run **in-process**, with the database handle, the service registry, and
full filesystem access. There is no sandbox and there will not be one soon. Do
not imply otherwise in docs. Therefore:

- `companion module install` accepts first-party / signed packages by default
  and requires `--allow-untrusted` for anything else, with a prompt that says
  what it means in one sentence.
- Manifests may *declare* capabilities for review and display, but declaration
  is documentation, not enforcement. Say so in the UI.

---

## 8. CLI surface `[NOW]`

Two transports, deliberately:

- `list`, `info`, `enable`, `disable`, `remove`, `config` talk **HTTP to a
  running daemon** and take effect live. These work today against existing
  routes.
- `add` and `verify` only touch `$COMPANION_HOME/modules/`, so they work while
  the daemon is down.

```
companion module list [--json] [--available]
companion module info <id>
companion module enable <id>
companion module disable <id>
companion module config <id> [--set k=v] [--unset k]
companion module install <id> [--set k=v]
companion module add <spec> [--force]     # fetch into <home>/modules + provenance
companion module remove <id>              # uninstall (down migrations + wipe config) + delete files
companion module verify <path>            # ABI conformance, for authors
companion module scaffold <id>            # generator matching modules/README.md §10
```

Vocabulary must match the kernel exactly, because users will read both:
`disable` keeps data, `uninstall` runs `down()` and wipes config, `remove` is
`uninstall` plus deleting the artifact.

`remove` is a daemon call, not a local one, even though it ends in deleting
files: the migrations have to come down while the code that defines them is
still on disk, and the CLI may be pointed at a host whose filesystem it cannot
reach. It refuses a module compiled into the build, which has no artifact to
delete.

**The same three verbs are on the Modules page**, gated by `modules:deploy`
rather than `modules:manage`: adding a module downloads and later executes code
on the host, which is a materially bigger capability than moving a switch on
code the instance already has. A spec typed into the browser must name a
registry package, while the CLI keeps everything `npm pack` accepts, because a
path spec would copy any directory the daemon can read into the directory it
imports from, and npm BUILDS a git spec, running its `prepare` script as the
daemon user before the ABI check has seen anything.

**Why `add` is its own verb**, against this document's earlier plan to overload
`install <id | pkg@version | ./bundle.tgz>`: the two take the same shape of
argument and mean different things, so `companion module install reports` cannot
be read reliably. `reports` is a plausible module id and a plausible package
name, and guessing from the string decides whether the command hits the network.
They also differ in precondition, since fetching files needs no daemon and
adopting one does. `add` obtains, `install` adopts.

**Auth:** do not reuse the admin password from `setup.ts`. Write a CLI token at
init into `$COMPANION_HOME/cli-token` (0600), store it hashed, scope it to
`settings:manage` + a new `modules:manage`. A CLI that needs an interactive
password prompt for `module list` will not be used.

**Fix the package name first** (Finding 4) so `npx @moxxy/companion module list`
is a real command.

---

## 9. Invariants, now enforced by `pnpm acl check` `[NOW]`

These are cheap now and expensive later:

1. The shell (`apps/web/src/App.tsx`, `apps/api/src/index.ts`) imports no
   `@companion/module-*` and hardcodes no module-owned string.
2. No exhaustive `switch` over `SpaServerMessage['t']`, `Permission`, or a
   `ServiceMap` key anywhere in `packages/*` or `apps/*`.
3. Cross-module access across an edition boundary uses `tryGet` / `ctx.bus`,
   never `get`. An OSS module may never name an enterprise module.
4. Enterprise modules extend the OSS admin surface through slots. There is no
   "replace a module" mechanism and there should not be one; two modules
   claiming the same nav key is a bug the kernel should reject at boot.
5. Every new module declares `edition` explicitly once §7 lands.

---

## 10. What enterprise needs from core, ranked

Modules cannot carry these. They are core changes and they gate deals.

1. **Custom roles.** `Role` is a closed union (Finding 3). Make it an open
   registry seeded with the three defaults, move the grid into a table assembled
   at boot from `acl.ts` defaults plus admin overrides, and keep
   `ctx.rbac.has(role, perm)` as the only read path so nothing else changes.
   Biggest single unlock; do it before the enterprise admin module. Full design,
   including the seven hardcoded sites that must change and the lockout escape
   hatch, is in **`docs/acl-and-roles.md`**; sequencing in **`docs/game-plan.md`**.
2. **Pluggable authentication.** The kernel holds one `Authenticator` set by
   `module-core`. Make it a small registry so an enterprise `sso` module can
   contribute OIDC / SAML, with local auth as one provider among several.
3. **Audit log.** The dynamic router is a **single choke point**: every route
   already declares `access`. Emitting an audit record centrally there gives you
   near-complete coverage for close to zero per-module work. This is a genuine
   architectural advantage of the current design and it is worth cashing in
   early. Core emits `ctx.audit`; an `audit` module persists, retains, exports.
4. **Secrets provider seam.** Module config secrets sit in SQLite today. Make
   the secret store an interface with the SQLite implementation as the default,
   so a KMS / Vault provider can replace it without touching a single module.
5. **A GitHub endpoint seam, for GitHub Enterprise and internal networks.**
   This is the item most likely to be misfiled as "an enterprise module", and it
   cannot be one: a module cannot reach into another module and change a
   constant. The OSS modules must grow the seam first; the enterprise module
   supplies credentials and policy on top of it.

   Two different customer situations get conflated, and they need different
   work:

   - **GitHub Enterprise Server** (self-hosted, `https://ghe.corp`, API under
     `/api/v3`). Needs a configurable endpoint. Today it is hardcoded in three
     places across two OSS modules: `const API = 'https://api.github.com'`
     (`modules/code/src/api/github-client.ts:15`),
     `https://github.com/${fullName}.git` for clones
     (`modules/operate/src/exec/checkouts.ts:107`), and `--hostname github.com`
     passed to the `gh` CLI (`modules/code/src/api/local-gh-account.ts`, plus the
     same in `apps/companion-cli/src/github.ts`). Path shape is compatible: a
     base URL of `https://ghe.corp/api/v3` composes correctly with every
     existing `${API}${path}` call, so this is a seam, not a rewrite.
   - **GitHub Enterprise Cloud with SAML SSO** (still github.com). The endpoint
     is fine; the *credential* is not. A PAT must be explicitly SSO-authorized
     for the org, and org policy commonly bans PATs outright. The fix is
     **GitHub App installation tokens** as an auth strategy in the existing
     multi-account registry, not an endpoint change.

   Both also need what an internal network always needs:

   - **An outbound HTTP dispatcher.** There is none today, and Node's global
     `fetch` ignores `HTTP_PROXY` / `HTTPS_PROXY` by default. On a corporate
     network with an egress proxy, every GitHub call fails with no knob to turn.
     One shared dispatcher (undici `ProxyAgent`, plus no-proxy rules) that the
     GitHub client and every other outbound call use.
   - **Custom CA trust** for TLS-intercepting proxies. `NODE_EXTRA_CA_CERTS`
     covers it at the process level, so this is documentation and a Docker
     mount point rather than code, but it must be tested, not assumed.
   - **Direct webhook delivery.** Delivery currently goes through the moxxy
     proxy tunnel, which registers a public URL. A GHES server sitting inside
     the same network can reach Companion directly, and the tunnel is often
     blocked outright. `COMPANION_PUBLIC_URL` already exists in `DaemonConfig`;
     the webhook surface needs to prefer it over the tunnel when set.

   Split: the endpoint seam, the dispatcher and direct delivery are **OSS**
   work in `code` / `operate` / `services`. The **enterprise** module owns
   GitHub App credentials, per-organisation endpoint policy, and the audit trail
   for both. Without the OSS seam the enterprise module has nothing to attach to.

6. **Air-gapped install.** Offline license, `module install ./bundle.tgz`, an
   image that never phones home, and a documented `pnpm` / registry mirror path.
7. **Backup, restore, upgrade.** One SQLite file makes backup trivial; write
   down the restore procedure and the "how far back can I roll a migration"
   answer before a customer asks.

---

## 11. The elephant: SQLite `[DECIDED: single-node appliance]`

**Decision: Companion is a single-node appliance.** Keep `better-sqlite3`, keep
synchronous stores, and write whatever SQLite SQL is clearest.

What settled it was not the database. The daemon holds git clones, worktrees,
scratch, run configs and the isolated moxxy home **on local disk**, so Postgres
would be necessary for multi-node and nowhere near sufficient: two daemons would
still fight over the same checkouts and both run every scheduled job. The port
costs a rewrite of every store plus an async conversion across ~55k lines, and
does not deliver the thing it was for.

Meanwhile execution **already** scales horizontally through `companion-runner`.
The daemon is the control plane, runners are the data plane, and the ceilings a
real deployment hits first are GitHub API rate limits and agent capacity, both
of which live outside the daemon.

Consequences, all now in force:

- HA is active/passive over a shared volume; recovery is one daemon boot.
- A second daemon on the same `COMPANION_HOME` refuses to start (`InstanceLock`),
  because otherwise duplicate scheduled jobs and contended worktrees would fail
  silently. Same-host `SIGKILL` is taken over immediately so supervisor restarts
  are unaffected.
- Active/active and multi-region are a **no**, stated plainly in `ENTERPRISE.md`
  rather than left ambiguous.

The original framing below is kept because the trade-off is still worth
understanding; it is no longer an open question.

### The original framing



Every store is per-module raw SQL over **synchronous** `better-sqlite3`. That is
a good fit for a single-node appliance and it is a large part of why this
codebase is fast and simple.

It also makes horizontal HA impossible, and enterprise RFPs ask for it. Porting
to Postgres is not a driver swap: it is rewriting every store *and* making every
call path async, across ~55k lines of module code. That is the most expensive
change in this document by an order of magnitude.

Decide now, in one sentence, which of these is true:

- **"Companion is a single-node appliance."** Legitimate, defensible, many
  successful products do exactly this. Sell HA as active/passive with a shared
  volume. Then keep `better-sqlite3` and stop worrying.
- **"Companion will need multi-node."** Then start constraining new SQL to a
  portable subset today and introduce a thin store adapter, because retrofitting
  it after 40 modules is not a project anyone will approve.

Not deciding is the expensive option: you accumulate SQLite-specific SQL for a
year and then discover the answer was the second one.

---

## 12. Build and Docker `[NOW]`

Unify on **one build output with three delivery vehicles.** Today the npx path
(`apps/companion-cli/build.mjs`: esbuild bundle plus the Vite `dist`) and the
Docker path (whole pnpm workspace plus `node_modules` copied into the runtime
stage) are two different artifacts with different failure modes.

Make the Docker runtime stage consume the CLI bundle:

```
build stage:    pnpm install --frozen-lockfile
                pnpm gen:modules --profile ${PROFILE}
                pnpm --filter @moxxy/companion bundle
runtime stage:  node + git + openssh + @moxxy/moxxy-cli
                COPY --from=build /app/apps/companion-cli/dist /app
                ENTRYPOINT ["/app/entrypoint.sh"]
```

The image loses the pnpm workspace and most of `node_modules` (only the
`better-sqlite3` native binding needs to survive), and the thing you test in CI
is the thing customers run via npx.

`entrypoint.sh` is what makes it end to end: ensure `$COMPANION_HOME`, seed the
admin from `COMPANION_ADMIN_USER` / `COMPANION_ADMIN_PASSWORD` (already
supported), bootstrap the moxxy provider from env when present, install any
external modules listed in `COMPANION_MODULES` or found under a mounted
`/modules-in` directory (this is the air-gap path), then start.

Keep the `companion-moxxy:/root/.moxxy` volume exactly as it is. The comment in
`docker-compose.yml` records a bug that was already paid for once.

Profiles become `docker compose --profile oss|full|enterprise` plus a
`PROFILE` build arg.

---

## 13. Sequencing

Ordered by (value delivered) / (cost), not by architectural elegance:

1. Fix the package scope (`@moxxy/companion` vs `@moxxy-ai/companion` vs
   `@moxxy/cli`). Hours. Blocks anything published.
2. `autoInstall: false` on the seven optional modules. Delivers "slim by
   default" today. Hours.
3. `companion module list|enable|disable|config` against existing routes, plus
   the CLI token. Days. This is the feature that was asked for, and it needs no
   new architecture.
4. Generated registries plus profiles plus the dependency-closure check. Days.
   Unlocks separate artifacts.
5. Shell slots: make `App.tsx` module-free (§5). A week. Unlocks every profile
   that is not a superset of `slim`, and it is the thing that makes "fully
   modular" true rather than aspirational.
6. Unify the Docker artifact with the CLI bundle plus `entrypoint.sh`. Days.
7. Publish `@moxxy/companion-sdk` and move in-tree modules onto it. A week.
8. Custom roles, then pluggable auth, then audit (§10). This is the enterprise
   product, and it is mostly core work, not module work.
9. Model B (external modules: import map, prebuilt client chunks, symlink farm,
   `module install`, `module verify`). Only when a second party is writing a
   module.

Steps 1 through 8 are done; see `docs/game-plan.md` for what each turned out to
cost and where building it changed the design. Step 9 (the ABI) is still gated on
a second party writing a module, and step 7 (the SDK) on the same trigger: see
§6.

---

## 14. Install lifecycle, requirements and binaries `[LATER]`

Today `install` is one atomic kernel call: validate config, run migrations,
register services, mount routes, activate. That works because every module is
compiled in and ships nothing but JavaScript. An external module that carries a
native binary, needs `git` on PATH, or must talk to a licence server breaks all
three assumptions. Design for that now, because the choices are hard to reverse.

### The phases an install actually has

```
fetch -> verify -> unpack (atomic) -> preflight -> migrate -> activate -> onInstall
```

Only the last three exist. The important addition is **preflight**: everything
checkable is checked before anything is written, so a failed install leaves no
trace instead of a half-unpacked directory. Unpack to a temp dir and rename;
never mutate the live module directory in place.

### Requirements are declared, not discovered

```ts
requires: {
  host: '>=0.4.0',                          // Companion version range
  node: '>=20',
  commands: ['git', 'gh'],                  // must resolve on PATH
  platforms: ['linux-x64', 'darwin-arm64'],
}
```

Pure data on the manifest, so the kernel can evaluate it **without loading the
module**, and the Modules page can grey out a module the host cannot run with
the exact unmet requirement. Evaluate at install, at every enable (a host
upgrade can invalidate it), and at boot. At boot, follow the existing prune
philosophy: disable with a logged reason rather than crash.

### Binaries: declared and verified, never fetched at install

```ts
binaries: [{ name: 'rg', path: 'bin/{platform}/rg', sha256: '...', version: '14.1.0' }],
```

The kernel resolves `{platform}`, verifies the checksum, sets the exec bit, and
hands the module `ctx.binaries.path('rg')`. Nothing is downloaded and nothing is
executed during install.

This is deliberate and it is the whole reason to reject npm-style postinstall
scripts: a script that fetches a binary breaks air-gapped installs, is not
idempotent, cannot be rolled back, has no checksum story, and runs before anyone
has reviewed the module. Modules ship the bytes they need, or they declare a
`commands` requirement and use what the host already has.

### Hooks: in-process, typed, not shell

Extend the existing `defineJobs` surface rather than inventing a script runner:

```ts
defineJobs({
  onInstall,    // NEW: after migrations, before activation. Seed rows, register a webhook.
  onUninstall,  // NEW: best-effort external cleanup. Must not block the uninstall.
  onEnable, onDisable, postActivate, jobs,
})
```

The module is already loaded in-process with `ctx.db` at this point, so a hook
adds **no** trust boundary that `onEnable` did not already cross. A shell script
would add one, plus an unbounded environment. `onInstall` must be idempotent:
install is retried after a failure.

### Configuration gaps worth closing

The declarative `config` spec (§4 of `modules/README.md`) is good and already
covers required fields, secrets, and install-time collection. Two things are
missing and both bite on first contact with a real integration:

- **Validation that needs I/O.** "Is this API token valid?" cannot be expressed
  as a `pattern`. Add an optional `validateConfig(ctx, values)` in the api slice,
  called during preflight, returning field-level errors. Without it the outcome
  is "installed and enabled but silently broken", which is the worst state to
  debug.
- **Config key migration.** A module version that renames a config key today
  silently orphans the stored value and the field reads as unset. Needs a rename
  map alongside the schema migrations, applied when the manifest version moves.

### Uninstall symmetry

`uninstall` already walks `down()` to zero (or calls `purge()` when any step is
irreversible), clears the migration ledger and wipes the module's config. Keep
that mandatory rather than offering a "leave the tables" option: the ledger and
the schema must move together, or a later re-install replays v1 against live
tables. The reversible verb already exists and is `disable`.

What the rollback needs around it:

- **Confirmation at the edge, not in the kernel.** The kernel should keep
  executing exactly what was asked; the CLI and the Modules page are where a
  destructive action gets confirmed. The CLI does this today (interactive
  confirm, or `--yes`, and it refuses with no TTY). The admin page needs the
  same treatment, naming `disable` as the alternative.
- **A pre-uninstall export.** There is no backup: once `down()` runs the rows
  are gone. `companion module export <id>` writing NDJSON of the module's tables
  before the drop turns an irreversible action into a recoverable one, and it is
  the same machinery an enterprise data-export requirement needs anyway.
- For external modules, additionally: remove unpacked binaries, run
  `onUninstall` best-effort, and drop `$COMPANION_HOME/modules/<id>` only after
  the ledger is clean. A failed `onUninstall` logs and continues; a module must
  never become impossible to remove.

---

## 15. Non-goals

- **Sandboxing modules.** Not achievable in-process; do not claim it.
- **A module marketplace / registry service.** npm is the registry. Revisit
  after there are external modules worth listing.
- **Replacing a module with another** (an "enterprise admin" that swaps out the
  OSS one). Extend through slots. A replace mechanism creates a
  resolution-order problem with no good answer.
- **Postgres**, unless §11 is decided the other way.
- **Per-module processes / isolation boundaries.** The single shared
  `better-sqlite3` handle and the synchronous service registry are the design;
  changing that is a different product.
