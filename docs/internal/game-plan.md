# Game plan: OSS + Enterprise Companion

Everything below is built. What is deliberately **not** built, and why, is
[`open-items.md`](open-items.md).

The execution plan across `docs/modular-distribution.md` (how modules ship) and
`docs/acl-and-roles.md` (who may do what). Read those for the reasoning; this
document is the order, the exit criteria, and the risks.

---

## The strategic point, first

**The plugin ABI is not on the critical path to selling an enterprise edition.**

What an enterprise buyer evaluates: custom roles, tunable permissions, SSO,
audit trail, air-gapped install, backup story. Of those, exactly zero require
out-of-tree modules. A private repo compiled into a separate artifact delivers
the whole OSS/Enterprise split with full type safety and no new mechanism.

What the ABI buys is a **plugin ecosystem**: third parties and customer-specific
modules installed without a redeploy. That is a real product, but it is a
different one, and building it first spends a month before the first thing a
customer will pay for exists.

So the plan below front-loads ACL, roles, and the CLI, and defers the ABI to
last. Phases 1 through 5 are all additive: no new concepts, each independently
shippable, nothing committing you to a public surface you must support forever.

---

## Dependency graph

```
P0 hygiene ─┬─> P1 CLI (module + acl read)      [P0..P7 DONE; P8/P9 gated on a second party]
            ├─> P2 ACL generation + checks ──> P3 open roles ──> P6 enterprise core
            ├─> P4 profiles + generated registries ──> P7 docker
            └─> P5 shell slots ──> (profiles narrower than slim)
                                                            P8 SDK ──> P9 ABI
```

P3 (open roles) is the single highest-value item and depends only on P2.
P5 (shell slots) is what makes "fully modular" true rather than aspirational,
and it is the prerequisite for any build profile narrower than `slim`.
P9 waits for a second party actually writing a module.

---

## P0. Hygiene and unblockers `[DONE]`

Small, independent, all of them things that get more expensive later.

1. **Package name.** `apps/companion-cli/package.json` said `@moxxy/companion`
   while its own README, its `--help` text and the root README all say
   `@moxxy-ai/companion`. Aligned to the documented name. (`@moxxy/cli` and
   `@moxxy/companion-runner` are separate products and were left alone: the
   scope mix is not a bug.)

   **Reversed later**: the published name is `@moxxy/companion`, and the help
   text, both READMEs and the docs follow it. The alignment was the point, not
   the direction. The Dockerfile no longer refers to the package by name at all,
   because a rename silently breaking `pnpm --filter` is how the image build
   broke once already.
2. **`autoInstall: false`** on `plan`, `planner`, `board`, `refinement`, `slop`,
   `playground`, `automations`. Verified: a fresh database now activates
   `admin, code, core, operate, workspace` and lists the other seven as
   Available. Existing instances are untouched, because boot's `ON CONFLICT`
   preserves an existing row's installed/enabled state.
3. **Collision detection** (finding F5 in the ACL doc), three places:
   - `ServiceRegistry.register` throws when a *different* module already owns
     the key. Same-module re-registration stays legal so a retry after a failed
     activation does not trip over its own leftovers.
   - `DynamicRouter.mount` throws on a duplicate method+path owned by another
     module, instead of letting first-match-wins pick silently.
   - `ModuleKernel.assertNoCollisions` rejects duplicate permission ids and WS
     message tags, at boot and on every enable, with the candidate named last so
     the error points at the module being enabled.

   Verified against the current tree before landing: 254 route declarations with
   zero duplicate method+path, and 64 declared permission/message ids with zero
   collisions. Nav-key collisions are client-side and stay with `acl check`.
4. **`OnboardingStep.need` renamed to `permission`** (F6), matching `NavEntry`
   and `ClientRoute`. `need` now unambiguously means a GitHub repo permission.
5. **Skills moved from the Playground sidebar group into Operate's own.** Fallout
   from item 2: `operate` deliberately declared a twin `playground` section so
   its `Skills` entry survived playground being disabled, which was free while
   playground was always installed. With playground now Available by default, a
   fresh instance rendered a "Playground" group containing only Skills. The page,
   route and API were always operate's, so the entry simply belongs in Operate.
   Installing Playground now adds a group holding Agent Lab and Pipeline Lab, and
   nothing else moves.

**Deferred to P1:** the CLI token. It is only consumed by the CLI, it touches
auth, and it deserves to land with the commands that use it rather than sitting
unused.

**Exit, met:** `pnpm -r build` and `pnpm -r typecheck` green,
`node scripts/acl.mjs check` clean (0 errors; the one pre-existing warning is
`operate: 'runners:manage' is declared but nothing gates on it`, a genuine dead
capability worth deciding on separately).

---

## P1. CLI: module, acl and role commands `[DONE]`

### Landed

1. **`modules:manage`**, a new core permission separating module control from
   `settings:manage`, which also covers branding and `recreate-db`. The six
   mutating `/api/modules/*` routes, the Modules nav entry and the Modules page
   route now require it. `GET /api/modules` stays `any`: the SPA bootstraps from
   it. Admin holds it through `admin: '*'`; no other role holds it today, so
   nothing in the UI changed.
2. **The CLI token.** `postActivate` in module-core mints a ten-year session
   through the existing `Auth.mintSession` and writes it to
   `$COMPANION_HOME/cli-token` with mode 0600. No new verification path: it is
   an ordinary hashed session row. A file holding a token the daemon no longer
   recognises (a password change drops the account's sessions) is re-minted at
   the next boot rather than trusted; a valid one is reused, so restarts do not
   churn sessions. If no admin exists yet (browser-only first-run onboarding),
   it is written on the next start.
3. **`companion module list|info|enable|disable|install|uninstall|config`**,
   with `--json`, `--set k=v`, `--unset k`, and `--home/--host/--port`. Values
   are coerced against the module's own declared field kinds, so the CLI and the
   admin form accept the same input. Errors surface the kernel's own message and
   exit non-zero.

**Correction to the earlier plan:** this local bootstrap token remains
**admin-equivalent**, not scoped to `modules:manage`. `$COMPANION_HOME` already
holds the database, so a 0600 file there does not widen that directory's blast
radius. Remote and least-privilege CLI/MCP clients now use separately managed,
expiring API tokens; their selected scope is enforced through
`rbac.allows(user, permission)`.

**Verified** against a throwaway daemon on an isolated `COMPANION_HOME`: the
full install/config/disable/enable/uninstall cycle, config wiped by uninstall,
dependency refusals (`enable dependency 'plan' first`), required-module refusal,
unknown module and unknown config key, unauthenticated and garbage-token calls
rejected, stale token re-minted, valid token preserved across restarts, and a
clear message when the daemon is unreachable.

4. **`companion acl map|explain` and `role list|show`.** `RbacGrid` now retains
   the ACL slices tagged with their owning module, so `RbacReader` gained
   `catalog()` and `explain(role, permission)`. Two routes in module-core behind
   `users:manage`: `GET /api/acl` (the live grid) and `GET /api/acl/explain`.
   The grid reflects the **enabled** set, which is the whole point of asking the
   daemon rather than reading `acl.ts`: installing `slop` moved admin from 22 to
   25 permissions and disabling it moved it back, verified live.

   `explain` names the mechanism rather than returning a verdict, and separates
   the three ways a permission can be missing, because the fix differs:

   ```
   DENIED  admin -> slop:read
     role 'admin'
     declared by module 'slop', which is installed but DISABLED
     hint: companion module enable slop
   ```

   versus `which is NOT installed` (hint: `install`) versus `no module in this
   build declares 'repos:reed' (typo?)`.

5. **Uninstall confirms before destroying data.** `uninstall` always walked
   `down()` to zero (or `purge()`), cleared the migration ledger and wiped the
   module's config; that is correct and must stay mandatory, because clearing
   the ledger while leaving tables behind would make a later re-install replay
   v1 against live tables. What was missing was a gate in front of it. The CLI
   now states what will be lost, points at `disable` as the reversible verb, and
   requires an interactive confirmation or an explicit `--yes`; with no TTY and
   no `--yes` it refuses.

   Verified at the SQLite level: install creates `slop_rules`,
   `slop_detections`, `slop_builtin_toggles` with ledger `[1]`; disable keeps
   all three; uninstall drops them and empties the ledger; re-install recreates
   them from scratch.

### Remaining

Nothing in P1. The next phase is P2 (generated ACL artifact and checks), for
which `scripts/acl.mjs` already exists as a working prototype covering `map`,
`check`, `add` and `sync`.

Vocabulary matches the kernel and must stay that way: `disable` keeps data,
`uninstall` runs `down()` and wipes config, `remove` (uninstall plus deleting the
artifact) belongs with external modules and does not exist yet.

---

## P2. ACL as a generated artifact `[DONE]`

`scripts/acl.mjs`, run as `pnpm acl <command>`. It reads each module's **built**
`dist/api/acl.js` and folds it with the kernel's own `buildRolePermissions`, so
the grid it prints is the grid the daemon computes, not a re-implementation. A
stale `dist` is detected and refused rather than silently trusted.

```
pnpm acl add <module> <id> --title "..." [--grant a,b] [--implies x]
pnpm acl sync [--dry]
pnpm acl check [--strict]
pnpm acl map [--by role|module|permission] [--role X] [--modules a,b] [--json]
```

`acl.ts` is the single authored source; the manifest array and the contract's
`PermissionRegistry` are derived from it. `add` threads all three sites, and was
used to add `modules:manage` in P1.

**Deviation from the plan, deliberately:** the derived sites are edited **in
place** rather than emitted as `contract/permissions.generated.ts`. `sync`
reconciles entries line by line, so surviving lines stay byte-identical and the
doc comments that live inside `PermissionRegistry` (operate has one) survive.
A generated file would have discarded them and needed an import wired in for no
gain, since `check` already makes hand-drift impossible.

`pnpm acl check` runs in CI after the build and fails on: three-way drift; a
permission id, WS message tag, `ServiceMap` key, route method+path or nav key
claimed by two modules; a permission gated on but declared nowhere; a grant
naming a permission its module does not own; an id that is not
`<resource>:<verb>`; `consumes` entries that are unknown, self-owned or stale;
and any change to the effective grid not mirrored in `docs/acl-grid.json`.

That last check is the one worth the most: the committed grid puts "this PR
changes who may do what" into the diff where a reviewer sees it. It records
roles and permission-to-owner-plus-grants only, deliberately excluding usage
sites, which would churn on every file move without saying anything about
capability.

**Two real findings came out of building it**, neither of them drift:

- The dead-permission rule was **wrong**. It only scanned `access:` and
  `permission:`, so it called `operate: 'runners:manage'` dead. It is not: every
  mutating runner route calls `requireManageableRunner`, and creating a *shared*
  runner checks `ctx.rbac.allows(user, 'runners:manage')` directly. Fixing the
  scanner to see `rbac.has(...)`, `rbac.allows(...)`, and `can(...)` mattered
  more than "fixing" the permission would have.
- With the wider scan, two genuine undeclared couplings appeared: `playground`
  gates on `code`'s `repos:read` and `slop` on `refinement`'s `refine:manage`,
  neither with a `dependsOn` edge. Both are **correct** soft uses that degrade
  when the owner is off, so the fix was to declare them via the new manifest
  `consumes` field rather than to change behaviour.

**Note on honesty:** there was no drift to fix. Verified across all 12 modules,
41 permissions, three declaration sites each. This phase prevents a future
problem and produces the artifact P3's role UI needs. It is not a bug fix.

---

## P3. Open roles `[DONE]`

Shipped: `Role` is a string id and `BuiltinRole` keeps the three-way union;
`roles` + `role_permissions` + `audit_log` land in module-core migration v2 with
the three built-ins seeded; `RbacGrid` folds instance overrides on top of the
module grants; `RolesService` owns the mutations behind `users:manage`;
`companion role list|show|create|delete|grant|revoke|reset|repair` drive it.

The fold is `base ∪ grants → expand implies → minus revokes → intersect with
what the ENABLED modules declare`. Revoke is applied last so an explicit revoke
always wins, and the final intersection is what makes a disabled module's
permissions vanish from every role **while the override rows stay in the
database**. Verified live: granting `slop:read` to a custom role, disabling
slop (role drops to 0 effective permissions), re-enabling it, and the grant is
back.

Modules still grant only to the built-in roles (`RoleGrants` is keyed by
`BuiltinRole`), so no module changed and none ever needs to know a custom role
exists. Custom roles are composed from the permission catalogue instead.

### Three things that only surfaced by running it

- **The anti-lockout guard did not work.** It threw, but the write had already
  landed and the "rollback" republished the same broken state, so the instance
  locked itself out exactly as designed to prevent. The check has to run after
  the write (only the grid knows a change's effective outcome), so it now
  captures the prior override slots first and restores them before throwing.
  Re-verified: refusing to revoke `users:manage` leaves the instance
  administrable and the override row gone.
- **`acl explain` printed contradictory lines** for the most important case,
  claiming both "granted by module code" and "no enabled module grants it". The
  `override` field existed in the DTO and the printer ignored it. It now names
  the override as the deciding mechanism and suggests `role reset`.
- **`role repair` did not detect a running daemon.** WAL mode lets a second
  writer take `BEGIN IMMEDIATE` whenever the daemon is idle, so the file lock is
  not a reliable signal. It now probes `/healthz` first and refuses, because a
  daemon holds the grid in memory and would overwrite the edit.

Also: audit records go to an `audit_log` **table**, not a log line. The npx CLI
starts the daemon at `COMPANION_LOG_LEVEL=warn`, so an info-level audit trail
would have been absent exactly where it matters.

### The Roles admin page

`modules/core/src/client/pages/Roles.tsx`, at `#/roles` under Admin, gated on
`users:manage`. Lists the roles, creates one (optionally cloning another),
deletes custom ones, and edits a role's permissions grouped by owning module.
The Users page is role-aware too: both role pickers and the filter read
`GET /api/roles` through `useRoles`, and descriptions come from the role record
rather than a hardcoded map.

The permission switch is the part with a real design constraint. A role either
follows what the modules grant or carries an explicit override, so ON and OFF do
not map to one API call each:

| | permission is a module default | permission is not |
|---|---|---|
| switch ON | `reset` (clear the revoke) | `grant` |
| switch OFF | `revoke` | `reset` (drop the grant) |

Without knowing the default, switching a permission off on a **custom** role
would write a `revoke` row for something the role never had. `RbacReader` gained
`baseline(role)` for exactly this, surfaced as `RoleDetail.defaults`, and the
same field drives the "granted here" / "revoked here" markers that show where the
instance decided differently from the modules.

Verified against a live daemon by replaying the page's own toggle computation:
built-in OFF then ON leaves **zero** override rows, custom ON then OFF leaves
zero, and neither accumulates a row that merely restates the default.

Not verified visually: the Chrome extension was not connected, so the page was
exercised through its two fetches (`GET /api/acl`, `GET /api/roles/:id`) and its
toggle logic rather than by driving the UI. Its chunk builds and ships
(`Roles-*.js`).

Full design in `docs/acl-and-roles.md` §D1.

1. `Role` becomes a string id; `BuiltinRole` keeps the three-way union. Fix the
   seven hardcoded sites listed in that document's F1 table.
2. `roles` and `role_permissions` tables in module-core, additive migration
   seeding the three built-ins. A no-op against a live database.
3. Grid folding gains the override layer: `(base ∪ grants) \ revokes`, then
   `implies` expansion, then drop permissions whose owning module is disabled.
   Overrides are **retained** in the database while their module is disabled.
4. `guardLastAdmin` becomes the real invariant: at least one enabled user holds
   `users:manage`, and `users:manage` cannot be revoked from the last role that
   has it.
5. Routes plus CLI: `role create|grant|revoke|delete`, `user role`.
6. `companion role repair --grant-admin <user>`, working **offline against the
   SQLite file with the daemon stopped**. Ship this in the same PR as the
   revoke capability, not after.
7. Admin UI page for role composition, rendering `title` (never the id) grouped
   by owning module.
8. Audit records for every role and grant change, from the first commit.

**Exit:** create a custom role from the CLI, assign a user, and watch nav,
routes and the API reflect it live. Revoke a permission from `maintainer` and
see the route 403. Disable the owning module and see the permission leave every
role, then re-enable and see the override restored. Lock yourself out
deliberately and recover with `role repair`.

**Risks:**
- Widening `Role` breaks every `Record<Role, X>`. There are only three such
  sites, all listed; this is mechanical, not architectural.
- The disabled-module interaction is the subtle part. Test it explicitly: an
  override that survives a disable/enable cycle is the whole point.
- Lockout is the realistic production incident. The escape hatch is not
  optional.

**Explicitly not in this phase:** renaming any of the 40 existing permission ids
(see F7 for why the churn is not worth it).

---

## P4. Build profiles and generated registries `[DONE]`

`profiles/slim.json` and `profiles/full.json` (which `extends` slim) are the only
place a build's module set is named. `scripts/gen-modules.mjs --profile <name>`
writes `apps/api/src/modules.generated.ts` and `apps/web/src/modules.generated.ts`,
both gitignored, and the hand-maintained `modules.ts` files are gone. `pnpm build`
and `pnpm typecheck` generate first, so a fresh clone needs no extra step.

The closure check is the part that earns its keep. A profile missing a
dependency, or a `required` module, fails with both sides named:

```
profile is not buildable:
  'code' depends on 'operate', which the profile omits
  'workspace' is required and cannot be excluded from a build
```

Measured difference between the artifacts: server bundle 804K vs 1.2M, SPA 824K
vs 1.1M, 39 chunks vs 69.

CI builds `full` (the superset, so every module compiles and every `dist/` the
later steps need exists), then runs `acl check`, then re-typechecks against
`slim`, which is the only profile where the shell could reference a module the
build does not contain.

One thing worth recording: the slim build compiles cleanly **today**, because
`slim` is exactly the closure of what `apps/web/src/App.tsx` statically imports.
Any profile narrower than slim still needs P5. The `slop-check` pipeline step
kind is a good example of the degradation working as designed: it lives in
`code`, resolves slop through `tryGet`, and in a slim build reports "the AI Slop
Detection module is not enabled" rather than failing to compile.

---

## P5. Make the shell module-free `[DONE]`

`apps/web/src/App.tsx` now imports **only** `core` and `workspace`, the two
`required: true` modules, and contains no module-owned string literal. Everything
else reaches the shell through slots:

| Slot | Contributor |
|---|---|
| `shell.banner` | operate: runner capacity |
| `shell.topbar` | operate: run queue + agent status; automations: AI Help |
| `shell.effects` | code: workspace-scoping the nav freshness badges |

Three mechanisms were needed, all small:

- **`Slot`** in `@moxxy/companion-core/client`, RBAC-filtered by a `can` passed in
  (core/client cannot import module-core's auth context, so the shell supplies it).
- **`registerFreshFilter`**, a module's veto on nav freshness marking. The shell
  used to hold `useWorkspaceRepos` to drop issue/PR activity for repos outside
  the active workspace; only `code` can know that, so it registers the filter
  from a `shell.effects` component.
- **`NavEntry.home`** (lowest wins) for the landing page, replacing a hardcoded
  `can('issues:read')`. A bare URL now resolves to whichever permitted entry
  claims it, so a build without `code` lands somewhere real instead of a 404.

`AgentsStatus` (137 lines of moxxy/GitHub status) moved out of the shell into
`modules/operate/src/client/components/`, where `operateApi` already lives.

**A measured defect this fixed, which P4's claim had missed:** the shell
statically imported `@companion/module-automations/client`, so the AI Help
assistant shipped in the **slim** entry bundle even though automations can never
be enabled there. The entry chunk went from 328K to 228K, and
`grep AssistantPanel` on the slim artifact now returns nothing.

**Acceptance, met by construction and by test:** a new `profiles/minimal.json`
(core + workspace only) builds, typechecks, boots and serves. All three profiles
are green. `pnpm acl check` gained a `shell-module-import` rule so this cannot
regress one convenient import at a time, and CI typechecks against `minimal`.

One cross-module reaction surfaced during the move and got a name rather than a
cast: `AgentsStatus` refreshes on `repos.changed`, which `code` owns and operate
does not depend on. `isMessage(msg, tag)` in `@moxxy/companion-core/client` is the
client twin of `ctx.services.tryGet`: absent owner, silent no-op.

### Original plan



The prerequisite for any profile narrower than `slim`, and the thing that makes
"fully modular" honest. `apps/web/src/App.tsx` (983 lines) statically imports
from `module-workspace/client`, `module-operate/client` and `module-code/client`,
and hardcodes `msg.t === 'issues.changed'`, `'prs.changed'`, `'repos.changed'`
and `can('issues:read')`.

Add shell slots to `@moxxy/companion-core/client` and move each coupling out.
`defineSlots` already exists and is already used for in-page contributions by
operate, slop and playground; this uses the same mechanism at the shell level.
Detailed mapping in `docs/modular-distribution.md` §5.

**Exit, as a mechanical test:** `apps/web/src/App.tsx` contains zero
`@companion/module-*` imports and zero module-owned string literals. Add that
grep to `acl check` or a lint step so it stays true.

`core` and `workspace` are `required: true`, so depending on their **contract
types** stays legitimate. Everything else goes through a slot.

---

## P6. Enterprise core `[DONE]`

None of these can be a module (see the ACL doc, and `docs/modular-distribution.md`
§10). All belong in the OSS repo even though enterprise is what pays for them.

1. **Pluggable authentication** `[DONE, with a reference OIDC module]`.

   The design conclusion that made this small: **token verification is not the
   seam.** `verify()` runs on every request, module-core owns sessions, and an
   SSO module does not want to replace any of that. What it needs to contribute
   is how a user proves identity the FIRST time, after which Companion mints an
   ordinary session. Built that way, adding SSO touches no hot path and
   `Authenticator` is unchanged.

   - `Auth.registerProvider({ id, label, startUrl })` returns an unregister
     function, so an identity module registers in `onEnable` and drops it in
     `onDisable` with no kernel involvement.
   - `GET /api/auth/state` (public, pre-login) lists them; the login page renders
     one button each. A plain link, not a fetch: the handshake is a browser
     redirect the module owns end to end.
   - `Auth.signInExternal(identity, policy)` finds or provisions the account and
     mints a session. The caller has already verified the assertion, which is
     correct: it is in-process module code, the same trust boundary as
     everything else the kernel loads.

   **Provisioning is off by default and can never create an administrator.** An
   identity-provider misconfiguration should lock people out, not hand the
   instance to whoever authenticates first. Verified, five ways: unknown user
   with provisioning off is refused; provisioning into a role that holds
   `users:manage` is refused by name; provisioning into a non-managing role
   works; a disabled account is refused; an existing enabled account signs in
   without provisioning. A provisioned account gets a random password nobody
   holds, so it is reachable only through the provider that created it until an
   admin resets it.

   Two module-core config fields carry the policy: `externalSignup` (boolean,
   default false) and `externalSignupRole` (default `business`).

   **`modules/oidc` is the proof the seam was the right shape**: it registers a
   provider, serves two public routes, calls `signInExternal`, and touches no
   core file. `full` build, not installed by default.

   Protocol choices worth keeping:
   - Authorization Code + **PKCE (S256)** + single-use `state` and `nonce`;
     `state` is compared in constant time.
   - **The ID token is mandatory and cryptographically verified** against the
     provider's bounded, cached JWKS. Only RS256/ES256 are accepted; issuer,
     subject, audience/authorised party, time claims, nonce and optional ACR /
     authentication age are validated before userinfo is trusted. Userinfo
     must then return the same `sub`. An unknown key or same-`kid` rotation
     triggers one forced JWKS refresh, never an unsigned fallback.
   - SAML is deliberately absent. XML DSig is a far larger surface, and every
     provider Companion targets speaks OIDC.

   Verified against a stub provider that actually enforces the protocol (rejects
   a wrong verifier, a reused code, wrong client credentials), plus the full
   browser flow through a live daemon: provisioning off refuses by name;
   provisioning on creates `alice.sso | business | alice@corp.test`; the minted
   token authenticates `GET /api/auth/me`; a second sign-in reuses the account;
   provisioning into `admin` is refused. Ten unit tests, each of the four
   security invariants killed by an individual mutation.

   One gap this closed on the way: the two routes are public GETs, so the
   router's audit hook does not fire. The module records the sign-in itself,
   with the issuer and the claimed username.
2. **Audit log** `[DONE]`. The bet paid
   off: `DynamicRouter` records one event per **mutating** request, so coverage
   came from one hook rather than N per-module call sites, and no module changed.

   ```
   admin  200  core  users:manage    rbac.change                      created role 'auditor'
   admin  201  core  users:manage    POST /api/roles
   admin  403  core  users:manage    POST /api/roles/:id/permissions
   bob    403  core  modules:manage  POST /api/modules/:id/disable
   ```

   Design decisions worth keeping:
   - **Reads are not recorded.** They would bury the writes in an append-only
     table, and a read leaves nothing to reconstruct.
   - **Refusals are recorded**, with the status the caller got. "Who tried and
     was stopped" is exactly what an auditor asks for, and it comes free because
     the catch block already knows the matched route.
   - The action is the route **pattern** (`POST /api/roles/:id/permissions`), so
     the table groups by action rather than fragmenting by id.
   - A service may add its own record when no single route describes the
     decision: `rbac.change` carries which permission moved, which
     `POST /api/roles/:id/permissions` cannot say. Two rows per action from
     different angles is deliberate, not duplication to remove.
   - **A failing sink never fails the request.** An audit gap is a problem; a 500
     on every write because the trail is unavailable is a bigger one.
   - `provideAudit` mirrors `provideAuthenticator` and last enabled provider
     wins, so a dedicated audit module (which sorts after core) takes over
     module-core's minimal table without a core change.

   **Retention and export followed** `[DONE]`, closing a gap this phase itself
   opened: an append-only table with no sweep is a disk incident waiting for its
   first busy year, which `companion-enterprise-readiness` already said out loud.

   - `auditRetentionDays` is a module-core config field (default 365, min 7), so
     an admin changes it in the UI rather than in code. A daily job sweeps, and
     the delete is **bounded per run** so a table left to grow for a year cannot
     lock the database in one statement; the job catches up over a few runs.
   - `GET /api/audit` is **keyset-paged on id**, not OFFSET: deep pages of an
     append-only table would otherwise scan everything before them.
   - `GET /api/audit/export` streams NDJSON. Both are behind a new `audit:read`
     permission rather than `users:manage`, so a custom **auditor** role can read
     the trail and nothing else. Verified: that role reads `/api/audit` and gets
     403 on `/api/users`, which is the P3 role system and this phase composing.

   One framework change was needed and is worth keeping: `Reply` gained an
   optional content type, because the router JSON-encodes every body, and NDJSON
   put through `JSON.stringify` becomes one quoted string with literal `\n` that
   no ingester accepts. `document(body, contentType, filename)` is the helper;
   any future CSV or download export needs the same thing.
3. **Secret storage seam** `[DONE]`. `kind: 'secret'` config routes through a
   `SecretStore` instead of going straight to the config table. The default
   implementation is the same SQLite table, so nothing migrates and a stock
   instance gains no moving part; `provideSecrets` swaps the backend the way
   `provideAudit` swaps the audit sink.

   **This was built against my own earlier advice.** The note in
   `companion-enterprise-readiness` said an interface was speculative generality
   because only the kernel writes config, so the swap would be a one-file change
   when a Vault provider actually existed. That reasoning holds for the *write
   path* and misses the part that is not mechanical: what happens to secrets
   already stored. The seam's real content is that decision, and it is worth
   deciding once, in core, rather than per provider.

   Three rules fell out of it, each with a test that fails when it is removed:
   - **The swap moves values and deletes the originals.** Without the move,
     enabling a Vault module silently un-configures every module; without the
     delete, plaintext stays in the file the swap was meant to empty.
   - **The provider's own credentials stay in the default store.** A Vault
     module cannot keep its Vault token in Vault.
   - **An external store is not inside the config transaction.** A rolled-back
     write it never saw would be a lie either way, so the write is deliberately
     outside rather than pretending to be atomic.

   No Vault or KMS backend ships. That is a module, and now it is only a module.
4. **GitHub endpoint seam** `[DONE]`.
   `DaemonConfig.github` (`COMPANION_GITHUB_API_URL`, `COMPANION_GITHUB_HOST`)
   now drives the REST client, `git clone`, the `gh --hostname` boot adoption and
   the UI's GitHub links, which reach the SPA through the pre-login bootstrap so
   they are right before anyone signs in. Daemon-level rather than module config
   because `code` speaks REST and `operate` clones, and operate cannot read a
   dependent's config. Verified against a stub API: the token probe hits the
   configured host and stores the account it returns.

   Two things the audit turned up that the original plan had not listed: the UI
   linked to github.com from three places, which would send a GHES user to the
   wrong site; and `readActiveLocalGhAccount` fetched the token with a hardcoded
   `--hostname` even after the status probe was parameterised.

5. **Outbound proxy dispatcher** `[DONE]`. `installOutboundProxy()` runs first
   thing in the daemon's `main()` and installs undici's `EnvHttpProxyAgent` as
   the global dispatcher, but **only when a proxy variable is actually set**:
   swapping the dispatcher for everyone would put a new component on the request
   path of the majority who have no proxy, for no benefit.

   **A correction to what this document said before.** The claim was that the npm
   `undici`'s `setGlobalDispatcher` does not reach Node's built-in `fetch`, and
   that honouring the proxy would therefore mean routing every outbound call
   through a shared client. That is wrong on Node 24: measured against a
   CONNECT-capable proxy, `globalThis.fetch`, `undici.fetch` and an explicit
   dispatcher all tunnelled through it. So this cost one dependency and one line
   at boot, with **zero call-site changes**.

   Worth recording how the measurement nearly lied: the first proxy only handled
   absolute-URI requests, so every undici path timed out with nothing in the
   proxy log, which looks exactly like "the dispatcher is ignored". undici
   tunnels with CONNECT even for plain http; adding a CONNECT handler flipped all
   three to success. A later run showed 2 CONNECTs for 3 requests, which is the
   agent reusing one pooled tunnel, not a bypass.

   Verified on the real daemon, three ways: `HTTP_PROXY` set gives CONNECTs
   through the proxy; no proxy variable gives none; `NO_PROXY` covering the target
   gives none.
6. **Entitlement gate** `[DONE]`. A manifest declares `entitlement: '<feature>'`;
   the kernel refuses install and enable without a licence granting it, and
   disables it at boot when the licence lapses. `packages/services/src/license.ts`
   verifies a detached Ed25519 signature over a JSON payload at
   `$COMPANION_HOME/license.jwt`, cached for a day. No licence server, no
   activation call, no phone-home: air-gapped installs are the point.

   The OSS build ships **no issuer public key**, which is correct rather than a
   gap. It contains no entitled module, and a build that cannot verify a licence
   must not pretend it can, so it fails closed. The enterprise build supplies
   `COMPANION_LICENSE_KEY`.

   Verified end to end with a generated keypair against six states: no licence
   and no key, a valid licence in a build with no key, no licence with a key,
   expired, a licence granting a *different* feature, and valid. Only the last
   installs; the rest refuse with the reason in the message.

   **Degradation, which is the property that matters**, verified separately:
   licensed and running (3 tables, config `corp-slop`), licence expires and the
   module is disabled at boot with a warning while its tables and config stay
   intact and the instance stays administrable, renewal plus enable restores it
   with the configuration unchanged. It never bricks and never deletes.

   Enforcement here is a contractual control with a technical speed bump, not a
   security boundary; anyone with the source removes it. It exists so an honest
   customer stays compliant and an auditor can see what was licensed.

---

## P7. Unify the build artifact and Docker `[DONE]`

One artifact, three delivery vehicles: the image, the npx tarball and a source
checkout now run the **same** bundle from `apps/companion-cli`. The runtime stage
carries `dist/` plus the three runtime dependencies the bundle leaves external,
and nothing else: no pnpm workspace, no TypeScript, no module sources.

Measured: the old runtime stage copied **156 MB** (`node_modules` 144 MB, plus
apps/packages/modules); the new one copies **1.8 MB**. Image sizes are 545 MB
(slim) and 546 MB (full), which says something worth recording: for the *image*
the profile is about which code is present to audit, not about size, because the
Debian base plus the moxxy CLI dominate. The size win from profiles lands in the
npx tarball, not here.

`docker/entrypoint.sh` runs the daemon with `exec`, so **PID 1 is node** and
SIGTERM reaches the kernel's shutdown path. Verified: `docker stop` logs
`shutting down…` rather than killing the process. It also warns when
`/home/node/.moxxy` is unmounted (the redeploy that silently loses every AI provider),
refuses `COMPANION_ADMIN_USER` without a password, and copies an optional
`COMPANION_LICENSE_FILE` into place.

`PROFILE` is a build arg (`docker build --build-arg PROFILE=full`).

**Two real defects the Docker build found**, neither visible locally:

- `gen-modules.mjs` read each module's **built** manifest, so it could not run
  before a build. Every local run worked only because a previous build had left
  `dist/` behind. The documented fresh-clone workflow in the README was therefore
  broken. It now reads `src/module.ts` source, which is what a pre-build tool
  should do.
- The old Dockerfile no longer builds at all: it never copied `profiles/` or
  `scripts/`, so `pnpm build` fails inside it. That is the artifact drift this
  phase set out to remove, caught in the act.

**Also, generation stopped being something to remember.** `pnpm install`, `dev`,
`build` and `typecheck` all regenerate the registries, and `COMPANION_PROFILE`
picks the set once for all of them. Verified by deleting both registries and
running `pnpm build` from nothing.

### Original plan



Today the npx path (esbuild bundle plus the Vite `dist`) and the Docker path
(the whole pnpm workspace copied into the runtime stage) are two different
artifacts with different failure modes. Make the runtime stage consume the CLI
bundle, so the thing CI tests is the thing customers run.

Add `entrypoint.sh`: ensure `$COMPANION_HOME`, seed the admin from env (already
supported), bootstrap the moxxy provider when env is present, install external
modules from `COMPANION_MODULES` or a mounted `/modules-in` directory (the
air-gap path), then start. Keep the `companion-moxxy:/home/node/.moxxy` volume
exactly as it is; the comment in `docker-compose.yml` records a bug already paid
for once.

**Exit:** `docker compose --profile oss up` gives a working instance with moxxy
CLI present, from a cold machine, with no host prerequisites.

---

## P8. Publish the SDK `[DONE]`

`@moxxy/companion-sdk`, five entry points, **227 curated symbols**. Ten
in-tree feature modules migrated onto it in the same phase, because an ABI only
external code uses rots within one release. `core`, `operate` and `admin` stayed
on the internal packages: they implement the host (auth and RBAC, the runner
integration, the db-recreate control), and the exclusion list from the curation
landed almost exactly on those three, which is the evidence the line is real
rather than convenient.

**The curation is the product, not the packaging.** `@moxxy/companion-core/server` also
exports `ModuleKernel`, `DynamicRouter`, `MigrationRunner`, `ServiceRegistry`,
`RbacGrid`, `WsHub` and `ModuleConfigStore`; a module reaching for any of them
would be welded to internals that must stay free to change. Seventeen host
symbols are excluded by name, plus eighteen runner wire-protocol types that are
plumbing between `operate` and `companion-runner`. `@moxxy/companion-ui` is the one
wildcard, because it is a leaf with nothing to curate away.

`packages/sdk/surface.json` pins the whole thing and `pnpm sdk:surface` is a CI
gate. Additions are printed, removals fail. `/ui` being a wildcard is exactly
why the snapshot expands it: deleting a shared component is a silent break for
every external module that rendered it.

### The finding that changed the design

The original plan had a `/contracts` entry point for the open registries. It
cannot work. **TypeScript binds declaration merging to the module that DECLARES
an interface**, so `declare module '@moxxy/companion-sdk/contracts'` creates a
second, unrelated `PermissionRegistry` and the module's permissions are silently
absent from `Permission`. Measured with a two-package probe: augmenting the
façade gives TS2820 on the augmented key; augmenting the declaring package
compiles.

Hiding that behind a façade would have shipped an ABI whose permissions quietly
fail to register, which is far worse than one extra package name. So
`@moxxy/companion-contracts` is part of the public ABI, for exactly one line in a
module's `contract` slice, and the reason is written down where an author will
hit it.

Moving the registries into the SDK to get back to one name was considered and
rejected: it inverts `contracts -> core -> sdk` into a package cycle with no
valid cold-build order, and splitting into two published packages leaves the
author with two names anyway.

---

## P9. External modules `[DONE]`

A module with routes, services, migrations, permissions, jobs and config can now
be published, dropped into `$COMPANION_HOME/modules/<id>/` and loaded by a
running daemon. Verified with a module built entirely outside the repo: its
permission entered the live RBAC grid, its migration ran, its config resolved,
and its routes served.

### The problem that shaped it

The design said "symlink farm". A symlink cannot work, and the reason is the
same one the doc gave for React on the client: the daemon ships as one esbuild
bundle, so there is no unbundled SDK on disk to point a symlink at, and a module
resolving its own copy gets its own `Reply` class.

**That failure is silent, and it was measured rather than assumed.** With a
second SDK copy in the module directory, `redirect('/board')` came back as
**HTTP 200 with the body `{"status":302,...}`** and a `text/plain` reply came
back as JSON. No error, no warning, nothing in the log, because
`result instanceof Reply` in the router is simply false. With the bridge in
place: 302, `text/plain`.

So the daemon publishes its live namespace objects on
`globalThis[Symbol.for('companion.abi')]` and generates a small package at
`$COMPANION_HOME/modules/node_modules/@moxxy/companion-sdk` that re-exports
them. Node's ordinary upward lookup finds it from any module directory. The
re-export list is the daemon's own namespace keys, not a file on disk, so the
bridge works inside a published bundle and cannot promise a symbol the running
build lacks. Cost measured on the slim build: **+9 KB** (836.3 KB from 827.4 KB).

### Killing the class mechanically

Two checks, both cheap, both refusing rather than warning:

- The daemon **refuses at scan time** any module directory containing
  `node_modules/@moxxy`, with the reason in the log, and keeps loading the
  other modules. Degradation, not a boot failure.
- `companion module verify [dir]` runs with no daemon at all, so an author can
  check a build on a laptop: `moxxy` block, ABI generation, entry files exist,
  the built chunk's static imports are a subset of the allowed specifiers, and
  no ABI package is vendored or listed as a runtime dependency.

`moxxy.abi` is a **generation** (`0.x`), not a semver range. Pre-1.0 every minor
may break, and a caret range would let a module built against 0.1 load into 0.4
and fail somewhere deep instead of at boot. `moxxy.id` must equal the install
directory, so one module cannot shadow another; entry paths that escape the
package are refused.

### The browser half

Same problem, different mechanism: Vite cannot code-split a package it did not
know about, and the app is bundled, so nothing bare survives in its output for
an import map to redirect. The map exists purely for the module chunk.

- Six **host entries** (`react`, `react/jsx-runtime`, `react-dom`, and the SDK's
  root / client / ui) are entry points of the SAME Vite build as the app, so
  Rollup puts React in a shared chunk both import. A separately built vendor
  bundle would have been a second React.
- They are emitted **unhashed** at `/host/*.js`. A module compiled months ago
  cannot know this release's chunk hashes; the import map is the indirection
  that fixes it, and app chunks stay hashed and cacheable.
- The daemon serves `/modules/<id>/client.js` from a map built at boot out of
  validated metadata, so the URL contributes an id and nothing else. It is
  unauthenticated because `import()` cannot carry a bearer token, and it is code
  rather than data, exactly like the SPA bundle.
- `ModulesProvider` falls back to that URL for any enabled module with
  `externalClient` and no compiled-in loader, and settles those loads instead of
  awaiting them as a group.

**Two things had to change to make this actually work**, both found by building
it rather than by reading the design:

1. Rollup renames entry exports by default, so `/host/react.js` shipped
   `export { e as r }` and `/host/sdk-client.js` shipped *nothing*.
   `preserveEntrySignatures: 'strict'` fixes it. The host entries exist for a
   consumer Rollup cannot see, so their signatures are the contract.
2. `export * from 'react'` silently produces an entry with only a default
   export, because React is CommonJS and Rollup cannot enumerate it statically.
   React's API is listed by name instead, which also makes it an ABI like any
   other.

And one real ABI gap: `/client` and `/ui` had a `source` condition only, so an
out-of-tree author could not typecheck a client slice at all. `@moxxy/companion-ui`
and `@moxxy/companion-core/client` now emit declarations and the SDK's entries carry a
`types` condition, with **no** runtime path, because a resolvable runtime path
there is exactly the second React.

Verified in a real browser (headless Chrome over CDP), not by inspecting files:
the module's nav entry renders in the sidebar, `#/hello` renders its page, its
`StatTile`s show data fetched through the SDK's `request()` with the host's
session, and the console is clean.

**The negative test is what makes that meaningful.** Strip the import map and
the same module fails with `Failed to resolve module specifier "react"`, logged
against the module id, while the rest of the shell renders normally and `/hello`
shows the ordinary 404. Loud failure and degradation, which is the pair worth
having.

Finally, the browser ABI is written down twice, in the Vite import map and in
the CLI's verify allowlist, so `pnpm sdk:surface` diffs them: a specifier the
verifier permits but the map omits fails at load, and one the map serves but the
verifier rejects makes a legitimate module unpublishable.

---

## Tests: what is now guarded, and one suite that is not

Everything above was verified by running it. That verification does not survive,
so the framework logic with the highest blast radius now has tests, in the
repo's existing style (`node:test` against `dist/`):

- `packages/core/tests/rbac-grid.test.mjs` (8) pins the fold ordering: a revoke
  applied before the `implies` expansion, or the declared-permission filter
  applied before the overrides, both produce a grid that looks plausible and is
  wrong. Also: custom roles start empty, an unknown role holds nothing, and a
  disabled module's permissions leave every role while its override rows survive.
- `packages/services/tests/license.test.mjs` (9) pins fail-closed in every
  direction: another issuer's signature, a tampered payload with a real
  signature attached, expiry, a licence granting a different feature, a build
  with no issuer key, a missing file, malformed input.
- `packages/services/tests/instance-lock.test.mjs` (6) pins both halves of the
  single-node guarantee: refuse a live holder, and never block a legitimate
  restart (a dead pid on this host is taken over immediately; another host is
  judged by heartbeat because its pid means nothing here).

**Each was proved by breaking the implementation**, not just by passing: swapping
the revoke/expand order fails exactly one test, removing the declared filter
fails two, making an unverifiable licence satisfy entitlements fails five,
trusting the signature fails two, and reporting a live pid as stale fails the
refusal test.

Totals across the workspace: 91 passing.

**Two pre-existing broken suites were repaired**, both the same failure mode:
a hand-written test fixture that stopped matching the code it stands in for.
Neither was caused by this work; both fail identically with every change here
stashed.

- `modules/code`: the account stubs predated a `binding()` call on the store.
- `modules/board`: the fixture predated the push-access precondition, so a task
  now stalls on the `github` blocker ("no GitHub owner") and never reaches the
  developer lifecycle the tests describe. The tests were right and the fixture
  was stale: giving the task an owning profile and a `verifiedClientFor` that
  grants push makes all eight pass. The runner also stopped hanging, because the
  hang was a consequence of assertions throwing mid-test and leaving a service
  undisposed, not a separate defect.

Diagnosing board took a probe rather than a guess: the notification count
assertion passed while the durable-blocker assertion failed, which only makes
sense if the notification came from a different blocker. Dumping the events
showed `blocker_notified: github` where the test expected `developer`.

## Cross-cutting invariants to enforce from P0 onward

Add these to review now, because each is cheap today and expensive later:

1. No exhaustive `switch` over `SpaServerMessage['t']`, `Permission`, or a
   `ServiceMap` key in `packages/*` or `apps/*`. Today there are none, and that
   is what keeps an open module set type-safe.
2. The shell imports no `@companion/module-*` and hardcodes no module-owned
   string (enforced mechanically from P5).
3. No OSS module names an enterprise module in any position.
4. Cross-edition and soft dependencies use `tryGet` / `ctx.bus`, never `get`.
5. Enterprise extends via slots. There is no module-replacement mechanism and
   adding one is rejected.
6. Every permission is threaded through `acl.ts` only, with the manifest and
   contract generated (from P2).

---

## The SQLite decision: made

**Companion is a single-node appliance.** Full reasoning in
`docs/modular-distribution.md` §11 and `ENTERPRISE.md` §2. The short version: the
database is not the binding constraint, the local filesystem is (clones,
worktrees, moxxy home), so Postgres would be necessary and nowhere near
sufficient; and execution already scales horizontally through
`companion-runner`, which is the layer that should scale.

Its technical consequence is built and verified: `InstanceLock` refuses a second
daemon on the same `COMPANION_HOME`, naming the process that holds it, and takes
over immediately from a same-host `SIGKILL` so supervisor restarts are
unaffected. Without it, scaling a deployment to two replicas duplicated every
scheduled job and contended every worktree, silently.

### The original framing



Every store is per-module raw SQL over **synchronous** `better-sqlite3`. That is
a good fit for a single-node appliance and a large part of why this codebase is
simple and fast. It also makes horizontal HA impossible, and porting to Postgres
means rewriting every store and making every call path async across roughly 55k
lines of module code.

Decide explicitly, in one sentence, and write it down: **single-node appliance**
(legitimate, sell HA as active/passive over a shared volume) or **multi-node
later** (then constrain new SQL to a portable subset starting now). Not deciding
is the expensive option, because it accumulates SQLite-specific SQL until the
answer turns out to be the second one.

This does not block any phase above. It blocks the RFP question you will be
asked in month three.
