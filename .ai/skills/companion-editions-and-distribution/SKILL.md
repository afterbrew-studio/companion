---
name: companion-editions-and-distribution
description: >-
  Decide which edition a Companion module belongs to (OSS vs Enterprise), where
  its code lives, and how it reaches a running instance: build profiles, the
  generated module registries, autoInstall vs profile exclusion, the entitlement
  gate, and the CLI / Docker delivery paths. Use when adding a module and asking
  "is this OSS or enterprise", when changing what ships by default, when touching
  profiles or the module registries, or when working on the companion CLI's
  module commands. Read alongside companion-build-module, which covers how to
  write the module itself.
---

# Editions and distribution

`companion-build-module` + `modules/README.md` tell you **how to write** a module.
This skill tells you **which edition it belongs to and how it ships**.

**Source of truth: `docs/modular-distribution.md`.** Read it before designing
anything here. It tags every mechanism `[NOW] / [NEXT] / [LATER] / [NO]`.

## Status: what exists today

Do not write code against a mechanism that is not built. As of now:

- `[NOW]` Runtime lifecycle: install / enable / disable / uninstall, migrations,
  RBAC recomputation, lazy `/api` and `/client` loading. All of it works.
- `[NOW]` `GET /api/modules`, `POST /api/modules/:id/{install,enable,disable,uninstall}`,
  `PUT /api/modules/:id/config` in `modules/core/src/api/routes.ts`.
- `[NOW]` `autoInstall: false` on a manifest lands the module as "Available"
  instead of installing it at boot.
- `[NOW]` Build profiles (`profiles/*.json`) + `pnpm gen:modules`, which writes
  the two gitignored `modules.generated.ts` registries and fails the build on a
  set that is not `dependsOn`-closed or omits a required module.
- `[NOW]` `companion module|acl|role` CLI verbs, and instance-defined roles with
  grant/revoke overrides on top of what the modules grant.
- `[NOW]` `entitlement` on the manifest plus the offline licence gate: the
  kernel refuses install/enable without it and disables the module at boot when
  the licence lapses, keeping its data.
- `[NOW]` The audit trail: the router records every mutating request, refusals
  included, into `audit_log`.
- `[NOW]` `@moxxy/companion-sdk`: the curated ABI, pinned by
  `packages/sdk/surface.json` and gated by `pnpm sdk:surface`. Every in-tree
  feature module imports it; `core`, `operate` and `admin` do not, because they
  implement the host.
- `[NOW]` Out-of-tree modules loaded from `$COMPANION_HOME/modules/<id>/`, server
  and browser both. See `companion-external-module`.
- `[LATER]` An `edition` manifest field. Deliberately absent: build profiles plus
  `entitlement` already cover "which modules ship" and "which are licensed", and
  a third axis would be a second way to say the same thing.

If a task needs a `[LATER]` mechanism, say so and propose the `[NEXT]` step
instead. Do not invent the field and hope.

## Decide the edition first

Ask, in order:

1. **Does it work without a license, for a solo maintainer?** Then OSS.
2. **Is it a compliance, identity, or fleet-scale control?** SSO/SAML/SCIM,
   audit export, custom roles, policy enforcement, secret backends, air-gap
   tooling. Then Enterprise.
3. **Is it a core generalization rather than a feature?** Custom roles,
   pluggable authenticators, an audit choke point. Then it is **core**, not a
   module, and it goes in the OSS repo even though enterprise is what pays for
   it. See `docs/modular-distribution.md` §10.

Case 3 is the one that gets misfiled. A module cannot open a closed union in
`packages/types`, it cannot retrofit an audit hook onto the router, and it
cannot change a constant inside another module. Putting core work behind a
module boundary produces a module that reaches into core and breaks the OSS
build.

The live example: "GitHub Enterprise support" sounds like an enterprise module,
but the API host, the clone host and the `gh --hostname` are hardcoded in
`code` and `operate`, and there is no outbound proxy dispatcher at all. The
**seam** is OSS work in those modules; the enterprise module owns only the
credentials and the org policy on top of it. See
`docs/modular-distribution.md` §10.

## Where the code lives

- OSS modules: `modules/<id>` in this repo, MIT.
- Enterprise modules: the separate private `companion-enterprise` repo,
  published as `@moxxy-ai/module-<id>`, consumed by the enterprise build profile.
- Rejected: an `ee/` directory in this repo. See §7 of the doc for why.

## Cross-edition rules (these are review-blocking)

- **An OSS module may never name an enterprise module.** Not in `dependsOn`, not
  in `ctx.services.get`, not in a type import. The OSS build must compile with
  the enterprise repo absent.
- Enterprise modules reach OSS modules normally (`dependsOn` + `ctx.services.get`).
- Enterprise **extends** the OSS surface through `defineSlots`, never by
  replacing a module. There is no replace mechanism and adding one is a `[NO]`.
- Cross-edition reactions go through `ctx.bus` / `ctx.services.tryGet`, so a
  missing counterpart degrades instead of throwing.
- Core and shell code must **never exhaustively switch** over `SpaServerMessage['t']`,
  `Permission`, or a `ServiceMap` key. Today they do not, and that is what keeps
  an open module set type-safe. Use equality predicates, as every `useLive` call
  already does.

## What ships by default

Two different levers. Do not confuse them:

- **Lighter default experience** = `autoInstall: false` on the manifest. Zero
  build work, works today, module lands under "Available" and its client chunk
  is never fetched. This is the right lever for "do not show eleven sidebar
  sections to a new user".
- **Smaller artifact / OSS tarball that physically excludes code** = build
  profile. Needed for the edition boundary, not for the UX.

Profiles (`profiles/*.json`; `full` `extends` `slim`):

| Profile | Modules |
|---|---|
| `slim` | core, workspace, operate, code, admin |
| `full` | slim + plan, board, refinement, planner, automations, slop, playground |
| `enterprise` | slim + enterprise modules |

`slim` is exactly the closure of what `apps/web/src/App.tsx` statically imports.
Any profile narrower than that **will not compile** until the shell is made
module-free (doc §5). If a task asks for a narrower profile, that refactor is
the prerequisite, not an optional cleanup.

When adding or moving a module between profiles, check the `dependsOn` closure:
`refinement` needs `plan` + `board`, `planner` needs `plan` + `board` +
`refinement`, `automations` needs `plan`. The generator must fail the build on
an unclosed set, and on a missing `required: true` module.

## Registries

`apps/api/src/modules.generated.ts` and `apps/web/src/modules.generated.ts` are
gitignored and regenerated by `pnpm install`, `dev`, `build` and `typecheck`, so
nobody runs the generator by hand. Adding a module means editing
`profiles/*.json`, never the registries. `COMPANION_PROFILE=full` switches every
one of those commands to the full set; `--profile` overrides it for one run.

The generator reads `src/module.ts` **source**, not `dist`: it runs before the
build (the apps import what it writes), so on a fresh clone or in a Docker build
there is nothing built to read.

Never write the **builtin** module map into `$COMPANION_HOME`. The builtin set is
a property of the build artifact; putting it in the data directory means an image
swap leaves a stale map. Only **external** modules get an entry in
`$COMPANION_HOME/modules/registry.json`.

## CLI verbs

Vocabulary must match the kernel exactly, because users read both:

- `disable` keeps data and tables.
- `uninstall` runs `down()` migrations and wipes the module's config.
- `remove` is `uninstall` plus deleting the artifact (external modules only).

`list`, `info`, `enable`, `disable`, `config` talk HTTP to a running daemon and
take effect live against routes that already exist. `install` of an external
module manipulates `$COMPANION_HOME/modules/` and then triggers a rescan, so it
also works while the daemon is down.

Auth: the daemon mints a long-lived session at boot into
`$COMPANION_HOME/cli-token` (mode 0600) and the CLI reads it. It carries the
primary admin's identity, so it is **admin-equivalent**: `require()` checks
`rbac.has(user.role, permission)` and there is no per-token scope. A `cli` role
holding only `modules:manage` is now expressible, so narrowing it is a small
follow-up rather than a new mechanism.

## Entitlement gate `[NOW]`

When it lands: `entitlement` on the manifest, checked by the kernel **at enable
time and once per day**, never on a request path. Offline Ed25519-signed license
at `$COMPANION_HOME/license.jwt` so air-gapped installs work. On expiry the
module degrades to read-only with a renewal banner. It never bricks an install.

Treat this as a contractual control with a technical speed bump, not a security
boundary, and do not write docs or comments that imply otherwise.

## Docker

One build output, three delivery vehicles (npx tarball, image, source dev). The
runtime stage should consume the CLI bundle from
`apps/companion-cli/build.mjs`, not the pnpm workspace. Keep the
`companion-moxxy:/root/.moxxy` volume in `docker-compose.yml` exactly as it is:
the comment there records a bug already paid for once.

## Checklist

- [ ] Edition decided by the three questions above, and it is not actually core work.
- [ ] No OSS module names an enterprise module, in any position.
- [ ] Cross-edition access uses `tryGet` / `ctx.bus`.
- [ ] Enterprise extends via slots; nothing is replaced.
- [ ] No exhaustive switch over a module-owned union was introduced.
- [ ] `dependsOn` closure holds for every profile the module appears in.
- [ ] Both registries updated (or `profiles/*.json` once codegen lands).
- [ ] Default-shipping decision made with the right lever (`autoInstall` vs profile).
