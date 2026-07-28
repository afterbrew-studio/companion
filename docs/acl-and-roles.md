# ACL, permissions and roles: current state and target design

Companion to `docs/modular-distribution.md`. That document covers how a module
ships; this one covers **who is allowed to do what**, which is the part that
blocks enterprise deals and the part that is hardest to change later.

Status tags as before: `[NOW]` exists, `[NEXT]` additive, `[LATER]` new
mechanism, `[NO]` rejected.

---

## 1. How it works today `[NOW]`

The design is good and worth preserving. Stated precisely so the changes below
stay additive:

- A **permission** is a string id declared by the module that owns it, in
  `src/api/acl.ts` via `defineAcl({ permissions, grants })`
  (`packages/contracts/src/rbac.ts`).
- `PermissionSpec` carries `id`, `title`, and an optional `implies` list that is
  expanded transitively.
- `grants` maps a role to a permission list or `'*'` (every permission this
  module declares).
- `buildRolePermissions(acls)` folds the **enabled** modules' ACL slices into a
  `Record<Role, Set<Permission>>`. `RbacGrid` holds it and rebuilds on every
  enable/disable, so a disabled module's permissions leave the grid immediately.
- Every route declares `access: 'public' | 'any' | Permission` and
  `DynamicRouter` enforces it centrally. **A route cannot forget auth.** This is
  the single most valuable property of the whole design.
- The client gets a flat permission array in the session and filters nav and
  routes through `can(p)`.

Measured, not assumed: **40 permissions across 11 modules** (admin declares
none), and the three declaration sites per permission are currently **fully
consistent, zero drift**.

---

## 2. Critical findings

### F1. `Role` is closed, and hardcoded in seven places

`packages/types/src/roles.ts` is `'admin' | 'maintainer' | 'business'`. Adding a
role today means editing:

| Site | What |
|---|---|
| `packages/types/src/roles.ts` | the union and the `ROLES` array |
| `packages/contracts/src/rbac.ts:38` | the `{ admin, maintainer, business }` grid literal |
| `packages/core/src/server/rbac-grid.ts` | the same literal again, as the field initialiser |
| `modules/core/src/api/routes.ts:8` | `z.enum(['admin','maintainer','business'])` |
| `modules/core/src/api/routes.ts:110` | inline narrowing of the `?role=` query param |
| `modules/core/src/api/auth.ts:219` | `guardLastAdmin(existing, 'business', ...)`, a hardcoded demotion target |
| `modules/core/src/api/users-store.ts:98` | `SELECT COUNT(*) ... WHERE role = 'admin'` |

Three packages and one module. And because `RoleGrants` is
`Partial<Record<Role, ...>>`, a module's `acl.ts` **cannot grant to a role that
does not exist at compile time**. Custom roles are not merely unimplemented,
they are structurally impossible without a core change.

### F2. The grid is compile-time only, with no instance override

`buildRolePermissions` reads module ACLs and nothing else. There is no table, no
route, no `ctx.rbac` write path. An instance admin **cannot** say "maintainers
must not merge pull requests" without forking the code.

This is arguably a larger gap than F1. Even a customer content with three roles
expects to tune them. Every RBAC feature comparison starts here.

### F3. Every permission is declared three times

For each permission id:
1. `src/module.ts` manifest `permissions: [...]` (documentation, served by `GET /api/modules`),
2. `src/api/acl.ts` `permissions: [{ id, title }]` (the real ACL),
3. `src/contract/index.ts` `interface PermissionRegistry { 'x:y': true }` (the type).

There is **zero drift today** (verified across all 12 modules), and nothing
enforces that. The value of generating the map is preventing drift and
producing a machine-readable artifact, not repairing existing damage. Say that
honestly rather than selling a fix for a problem that has not happened yet.

Note the practical consequence of drift if it did happen: a permission missing
from the manifest is invisible to `GET /api/modules` and therefore to any future
role-composition UI, while still being enforced by the router. That failure is
silent in exactly the direction you least want.

### F4. Cross-module permission use is common and undeclared

Verified by scanning every `access:` / `permission:` site against the owning
module's `acl.ts`:

| Consumer | Owner | Permissions |
|---|---|---|
| `admin` | `core` | `settings:manage` |
| `operate` | `core` | `settings:manage` |
| `code` | `core` | `settings:manage` |
| `code` | `operate` | `runs:read`, `runs:act`, `skills:manage` |
| `automations` | `core` | `settings:manage` |
| `automations` | `workspace` | `reports:read` |

All are legal today because a `dependsOn` edge happens to exist in each case.
Nothing declares the consumption, and nothing checks it. The hazard: a route
gated on a **foreign** permission becomes unreachable for every role the moment
the owner is disabled, because the grid drops it. Only the hard dependency graph
protects that, and it protects nothing for a **soft** (`tryGet` / `ctx.bus`)
relationship, which is exactly what cross-edition and external modules must use.

### F5. There is no collision detection anywhere

Confirmed by reading the code, not inferred:

- `ServiceRegistry.register` is `services.set(key, impl)`. **Last writer wins,
  silently.** Two modules registering `'code'` and one of them just disappears.
- `DynamicRouter.mount` keeps a per-module list and flattens. No duplicate
  method+path check.
- The kernel performs no duplicate check on permission ids, WS message tags, or
  nav keys. The `messages` manifest field is documented as being for "conflict
  detection"; nothing implements it.
- TypeScript does not save you: two modules declaring
  `interface PermissionRegistry { 'foo:read': true }` **merge silently** because
  the types are identical. Same for a `ServiceMap` key with an identical type.

In-tree this is masked by review. For an open module set it is a correctness
hole, and it is the cheapest thing on this list to fix.

### F6. `need:` is overloaded

`defineOnboarding([{ need: Permission }])` uses `need` for a Companion
permission. `ghAccounts.verifiedClientFor(..., { need: 'push' })` uses `need`
for a **GitHub repository** permission (`pull` / `push` / `admin`). Two
different vocabularies, one key name, in the same codebase. Nav entries and
client routes already use `permission:`. Rename onboarding's to `permission:`
for consistency; leave the GitHub one alone (it is the right word there).

### F7. Permission vocabulary is inconsistent, and renaming is not worth it

The 40 ids use seven verbs (`read`, `manage`, `act`, `run`, `execute`, `create`,
`connect`) and mix resource granularity: sometimes the module id (`slop:`,
`board:`, `planner:`), sometimes a sub-resource (`repos:`, `issues:`, `prs:`,
`pipelines:` all inside `code`).

For a customer composing a custom role in a UI, an inconsistent vocabulary is a
real usability cost. But renaming 40 ids across 12 modules means churn in every
module, every doc, and a migration of any stored grant, for zero behavioural
gain. **Recommendation: do not rename.** Instead:

- The role UI displays `title`, never the id. Titles are already authored.
- Add an optional `group` to `PermissionSpec` for UI grouping.
- Enforce the vocabulary for **new** permissions via `companion acl check`.
- Require external modules to prefix ids with their module id, and reserve that
  prefix at boot.

### F8. Two smaller notes

- `implies` is collected across all enabled ACLs before expansion, so an
  implication whose *implied* permission belongs to a disabled module silently
  vanishes. Correct behaviour, worth a comment.
- Client `can()` is `permissions.includes(p)`, O(n) per call in nav rendering.
  With 40 permissions this is irrelevant. Revisit only if custom roles push the
  catalog into the hundreds, and only with a measurement.

---

## 3. Target design

### D1. Roles: open set, built-ins seeded, modules unaffected `[SHIPPED]`

Implemented as designed. Two corrections the implementation forced, both worth
carrying into any future work here:

- The keystone guard **cannot** be a pre-check. Only the grid knows a change's
  effective outcome, so the write happens, the grid republishes, the check runs,
  and the prior override slots are restored if it failed. A pre-check would mean
  reimplementing the fold, and a second fold that drifts from the real one is
  worse than no check.
- Audit records go to a **table** (`audit_log`), not the logger. The CLI starts
  the daemon at `COMPANION_LOG_LEVEL=warn`, so an info-level trail is missing in
  the default deployment.


The key move that keeps this additive: **modules grant to built-in roles only.
Custom roles are composed by instance admins from the permission catalog.** A
module never needs to know a custom role exists, so no `acl.ts` changes and no
module churn.

```ts
// @companion/types
export type BuiltinRole = 'admin' | 'maintainer' | 'business';
export const BUILTIN_ROLES: readonly BuiltinRole[] = ['admin', 'maintainer', 'business'];
export type Role = string;          // a role id; built-ins are just seeded rows
```

```ts
// @moxxy/companion-contracts
export type RoleGrants = Partial<Record<BuiltinRole, readonly Permission[] | '*'>>;
```

Two core-owned tables (additive migration, seeds the three built-ins):

```
roles(id TEXT PK, title TEXT, description TEXT, builtin INTEGER, created_at INTEGER)
role_permissions(role_id TEXT, permission TEXT, mode TEXT CHECK(mode IN ('grant','revoke')), PRIMARY KEY(role_id, permission))
```

Effective grid, computed on boot and on every enable / disable / role edit:

```
for each role r:
  base = builtin(r) ? fold(module acl grants for r) : {}
  effective(r) = (base ∪ grants(r)) \ revokes(r)
  then expand `implies`
  then drop every permission whose owning module is not enabled
```

Properties this buys, and each one matters:

- Built-in roles keep working exactly as today when there are no overrides. The
  migration is a no-op against a live instance.
- `revoke` on a built-in role answers F2 ("maintainers must not merge") without
  forking.
- Overrides are **stored even when the owning module is disabled**, and filtered
  at fold time. Re-enabling the module restores the grant instead of silently
  having dropped it.
- `ctx.rbac.has(role, perm)` is unchanged, so no module and no route changes.
  `RbacReader` stays the only read path.

`guardLastAdmin` generalises to the invariant that actually matters: **at least
one enabled user must hold `users:manage`**. Same for the role side: you may not
revoke `users:manage` from the last role that has it. The hardcoded
demote-to-`'business'` becomes "refuse the operation", which is the honest
behaviour anyway.

### D2. The ACL map: one authored source, everything else generated `[NEXT]`

Author writes `src/api/acl.ts` and nothing else. A generator produces:

- the manifest `permissions: [...]` array (kept in a separate generated file the
  manifest spreads, so `module.ts` stays import-free and eagerly loadable),
- `src/contract/permissions.generated.ts` with the `PermissionRegistry`
  augmentation, imported by `contract/index.ts`.

The generator parses `acl.ts` syntactically (the permission list is a literal
array), so there is no runtime cycle and no need to execute module code.

It also emits a single repo-wide artifact, the **ACL map**:

```jsonc
{
  "version": 1,
  "permissions": {
    "repos:read": { "owner": "code", "title": "View connected repositories", "implies": [],
                    "grants": ["admin", "maintainer", "business"],
                    "usedBy": [{ "module": "code", "kind": "route", "at": "GET /api/repos" }, ...] }
  },
  "roles": { "admin": ["..."], "maintainer": ["..."], "business": ["..."] },
  "modules": { "code": { "owns": ["..."], "consumes": ["runs:read", "settings:manage"] } }
}
```

This artifact is what the CLI prints, what CI diffs, and what a future
role-composition UI renders. It is the reason to generate rather than to
hand-maintain.

### D3. Checks: build time and boot time `[NEXT]`

Build time (`companion acl check`, a CI gate):

- declaration drift between `acl.ts`, the manifest, and the contract,
- duplicate permission id, WS message tag, `ServiceMap` key, nav key, or
  method+path across modules,
- a permission used in `access:` / `permission:` that no module declares,
- a permission used from another module that is **not** in the `dependsOn`
  closure (F4), unless declared in a new manifest `consumes: [...]`,
- a grant referencing an unknown permission,
- a declared permission that nothing uses (dead capability),
- naming policy for new ids (F7).

Boot time (kernel), because external modules bypass the build entirely: the same
duplicate checks over the **enabled** set, failing the enable with a clear
409 instead of silently overwriting. And `ServiceRegistry.register` must throw
on a duplicate key rather than last-writer-wins (F5).

### D4. Declaring foreign consumption `[NEXT]`

```ts
// src/module.ts
consumes: ['settings:manage', 'runs:read'],   // permissions owned by other modules
```

Cheap, documentation-grade, and it turns F4 from invisible into checkable. The
generator verifies each entry resolves to an enabled-reachable owner.

---

## 4. CLI surface for ACL and roles

Two transports, and the split matters because half of these are repo-time and
half are runtime:

**Repo-time (developer machine, CI):**

```
companion acl sync                       # regenerate manifest + contract from acl.ts
companion acl check [--strict]           # the CI gate (D3). Non-zero exit on any finding
companion acl map [--json] [--by role|module|permission]
companion acl diff <ref-a> <ref-b>       # grid delta between two builds or profiles
companion acl scaffold <module> <id> --title "..." [--grant maintainer] [--implies x:y]
```

`acl scaffold` writes the permission into `acl.ts` and runs `acl sync`, so the
three declaration sites can never be half-threaded by hand. This is the command
that makes F3 structurally impossible rather than merely currently-fine.

**Runtime (against a running daemon, CLI token):**

```
companion acl map --live                 # the EFFECTIVE grid, including DB overrides
companion acl explain <user|role> <permission>
companion role list
companion role show <id>
companion role create <id> --title "..." [--from <role>]
companion role grant  <role> <permission>...
companion role revoke <role> <permission>...
companion role delete <id>
companion user role <username> <role>
```

`acl explain` is the highest-value command here and the one support will live
in. Its output must name the mechanism, not just the answer:

```
$ companion acl explain maintainer prs:act
GRANTED
  via module `code` acl.ts grants.maintainer
  not overridden by any role_permissions row
  owning module `code` is enabled
```

```
$ companion acl explain alice runs:act
DENIED
  alice has role `release-manager` (custom)
  `runs:act` is owned by module `operate` (enabled)
  no grant row for role `release-manager`
  hint: companion role grant release-manager runs:act
```

### The lockout escape hatch

An admin **will** revoke the wrong thing. Ship the recovery before the feature:

```
companion role repair --grant-admin <username>
```

It must work **offline, against the SQLite file, with the daemon stopped**,
since a lockout can prevent the daemon from serving the route that would fix it.
This is a five-line command and its absence turns a support ticket into a data
recovery job.

### Audit

Role creation, grants, revokes, and user role changes are audited from the first
commit, not retrofitted. These are exactly the records a customer's auditor
asks for, and they are trivial to emit at the point of change.

---

## 5. What stays the same

Worth stating explicitly, because the temptation during this work is to redesign
more than necessary:

- `defineAcl({ permissions, grants })` is unchanged. No module edits.
- `route({ access })` and central enforcement are unchanged.
- `ctx.rbac.has(role, permission)` remains the only read path.
- `implies` semantics are unchanged.
- The client still receives a flat permission list and calls `can()`.
- Permissions still disappear from the grid when their owning module is
  disabled, and their routes still 503.

The entire change is: where the grid gets its inputs, and who may edit them.
