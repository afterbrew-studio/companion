# Developing Companion

## Getting started

```sh
corepack enable
pnpm install
cp .env.example .env
```

Edit `.env` and change at least `COMPANION_ADMIN_PASSWORD`. Source development
uses the daemon's `password` default; a clean setup with no seeded credentials
runs first-boot onboarding in the browser instead. Trusted local admission is a
deliberate npx mode, not an implicit consequence of binding development to
loopback.

Contributors usually want every module, not the shipped default. Set it once and
`install`, `dev`, `build` and `typecheck` all follow:

```sh
export COMPANION_PROFILE=full
pnpm build
pnpm dev
```

`pnpm dev` runs the daemon on <http://127.0.0.1:8901> and Vite on
<http://127.0.0.1:5173>, with `/api` and `/ws` proxied. Open the Vite port and
sign in with the seeded admin, or complete onboarding.

Then add a GitHub token or account in Settings, and turn on whichever modules you
want from the **Modules** page. A fresh install enables every module of the
`slim` profile (all 13: the required `core` and `workspace`, plus
`integrations`, `operate`, `code`, `coderabbit`, `jira`, `notify`, `workbench`,
`admin`, `plan`, `board` and `automations`); the modules `full` adds
(`refinement`, `planner`, `slop`, `playground`, `cursor-bugbot`, `oidc`,
`runtime`) wait under **Available**.

Before opening a pull request, run what CI runs:

```sh
pnpm build && pnpm typecheck && pnpm acl check
```

`pnpm smoke` boots the built daemon against a scratch `COMPANION_HOME` and walks
the documented first-run path (bootstrap token, first-admin setup, login, create
and list a workspace) over the real HTTP API. `pnpm e2e` drives the built SPA
through that same daemon in chromium (`npx playwright install chromium` once)
and asserts the shell, core routes and the live socket stay healthy.

## Commands

```sh
pnpm dev             # daemon + Vite
pnpm build           # generate the module registries, then build everything
pnpm typecheck       # generate, then type-check everything
pnpm test            # workspace tests where present

pnpm gen:modules --profile <slim|full>   # rewrite the registries (usually automatic)
pnpm acl check                           # RBAC gate (also runs in CI)
pnpm acl map --by role                   # what each built-in role holds
pnpm sdk:surface                         # the published module ABI (also runs in CI)
```

`pnpm build` and `pnpm typecheck` run `gen:modules` first, so a fresh clone works
with no extra step.

## Tests, and why there is no coverage gate

`pnpm test` runs over 1,250 `node:test` cases across 186 files. There is no
coverage report and no percentage threshold, and that is a decision rather than
an omission.

A line-coverage floor would measure the wrong thing here. These tests are
behavioural on purpose: routes are driven over a real socket, stores over a real
SQLite file, the router over a real HTTP server. A percentage rewards touching
row mappers and getters, and says nothing about whether the RBAC gate, the
webhook HMAC check or the seed path is actually exercised. Set the floor low
enough to pass today and it gates nothing; set it high enough to bite and the
cheapest way to pass is a test that asserts nothing.

What guards the codebase instead:

- **A red-first test wherever behaviour changes.** Write the test, watch it fail
  against the unfixed code, then fix. A regression test whose failure you never
  saw is a test you have not verified.
- **Gates that fail the build on the invariants that matter**: `pnpm acl check`
  (the RBAC grid), `pnpm sdk:surface` (the published module ABI), `pnpm smoke`
  (the documented first-run path over real HTTP) and `pnpm e2e` (the SPA shell
  and the live socket).

Revisit this if a class of regression starts escaping the suite repeatedly, or
if contribution volume outgrows reviewers judging test adequacy by reading the
diff. Either would be evidence a blunt instrument beats none. Neither is true
today.

## Build profiles: what ships

The set of modules a build **contains** is named in exactly one place,
`profiles/*.json`:

| Profile | Modules | Used for |
|---|---|---|
| `slim` (default) | 13 modules: the required core plus integrations, execution, code/review, notification, workbench and contributor workflows | the default OSS image and source build |
| `full` | `slim` + `refinement`, `planner`, `slop`, `playground`, `cursor-bugbot`, `oidc`, `runtime` | all 20 OSS modules in this repo; the published npx package is built from it |
| `cloud` | `slim` + `oidc`, `runtime` | hosted control plane with built-in execution and SSO |
| `minimal` | `core`, `workspace` | the guard that the app shell depends on no optional module |

```sh
export COMPANION_PROFILE=full   # or: pnpm gen:modules --profile full
pnpm build
```

**The profile is chosen when the artifact is built, not when it runs**, so the
install path decides whether you can pick one at all:

| Install path | Profile |
|---|---|
| `npx @moxxy/companion` | `full`, fixed: the published bundle carries every module. A fresh install enables the slim baseline; `COMPANION_PROFILE=full` on the **first run** additionally installs the planning cluster and reactors |
| Docker | `--build-arg PROFILE=full`, or `COMPANION_PROFILE=full` via compose |
| From source | `COMPANION_PROFILE=full pnpm build` |

Setting `COMPANION_PROFILE` as a *runtime* variable does nothing, and that
failure is silent, so check the build output rather than the running instance.
The generator prints exactly what it produced:

```
profile 'full': 20 module(s) [core, workspace, integrations, admin, oidc, operate, ...]
```

The registries (`apps/*/src/modules.generated.ts`) are **gitignored** and
regenerated by `pnpm install`, `dev`, `build` and `typecheck`, so you never run
the generator yourself. A committed registry would drift from the profile the
moment someone edited one and not the other.

The generator refuses a profile that is not closed under `dependsOn`, or that
omits a `required: true` module, naming both sides:

```
profile is not buildable:
  'code' depends on 'operate', which the profile omits
  'workspace' is required and cannot be excluded from a build
```

Being in a build is not the same as being on. The modules `full` adds ship with
`autoInstall: false`, so a fresh `full` install still boots with the slim baseline
enabled and the rest waiting under **Available**.

## Writing a module

[`modules/README.md`](../modules/README.md) is the complete authoring guide. For
a module that lives outside this repository, see
[`operating-modules.md`](operating-modules.md#out-of-tree-modules).
