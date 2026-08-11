---
name: companion-contract-and-rbac
description: >-
  How to evolve the shared spine safely: add a DTO that crosses the HTTP/WS
  boundary, add a Permission and thread it end-to-end, add a SpaServerMessage
  event, or open one of the declaration-merged registries (permissions, WS
  messages, services, bus events). Use whenever a type crosses the client/server
  boundary or a new capability is needed. Getting this wrong silently breaks RBAC
  or the live stream.
---

# Contract & RBAC

The spine is **open registries**, not closed unions. `packages/contracts`
declares empty interfaces; each module's `src/contract/index.ts` augments them,
so the derived unions (`Permission`, `SpaServerMessage`, `ServiceMap`,
`BusEvents`) are exactly the set of modules in this build. No codegen, no central
list to edit.

```ts
// modules/<id>/src/contract/index.ts
declare module '@moxxy/companion-contracts' {
  interface PermissionRegistry { 'widgets:read': true; 'widgets:manage': true }
  interface ServerMessageRegistry { 'widgets.changed': Record<never, never> }
  interface ServiceMap { widgets: WidgetService }
}
export interface WidgetRecord { readonly id: string; readonly createdAt: number }
```

**Compile-checked shape, runtime-checked presence.** A permission or service is
in the *type* whether or not its module is enabled. Always go through
`ctx.rbac` / `ctx.services.get` (across a declared `dependsOn`) or `tryGet` (soft);
never infer presence from the type.

## Adding a DTO

Put it in your module's contract slice, all fields `readonly`. Comment the
non-obvious ones, especially `null` semantics. Types are erased at runtime, so a
DTO costs nothing; it exists to keep both sides of one fetch in agreement.

Renaming or removing a field is breaking across both slices. Let the typechecker
enumerate the call sites and fix each; do not `any` past them.

## Adding a Permission

**Use the tool.** `acl.ts` is the single authored source; the manifest's
`permissions` array and the contract's `PermissionRegistry` are derived from it,
and `pnpm acl check` fails on drift.

```sh
pnpm acl add widgets widgets:manage --title "Create and edit widgets" --grant admin,maintainer
pnpm acl sync    # if you edited acl.ts by hand
```

Then gate the capability everywhere it is exercised:

1. **Route**: `access: 'widgets:manage'` on each `route({...})`. The router
   calls `require(user, access)` centrally; never check inside a handler.
2. **Nav entry** and **client route**: the `permission:` field.
3. **Programmatic checks**: `ctx.rbac.allows(user, perm)` when deciding what an
   authenticated caller may do, `ctx.rbac.has(role, perm)` only for role policy
   or background identities, and `can(perm)` on the client. `allows` intersects
   the live role grid with a managed API token's permission scope; checking only
   `user.role` would let a scoped token escape its ceiling.

Route `access` also takes `'public'` (no auth) and `'any'` (any signed-in user).

Naming is `<resource>:<verb>`; reuse an existing verb rather than inventing a
synonym. `acl check` enforces the shape.

**Grants are keyed by built-in role only** (`admin`, `maintainer`, `business`).
A module cannot know the custom roles an instance defines, and does not need to:
instance admins compose custom roles from the permission catalogue, and an
explicit instance revoke beats any module grant. Your `acl.ts` never changes when
someone adds a role.

## Adding a live WS event

1. Augment `ServerMessageRegistry` in your contract with `'<area>.changed'`.
   Coarse `'<area>.changed'` signals trigger a refetch; carry a payload only when
   the client can patch in place (`run.changed` carries the record).
2. Declare the tag in the manifest's `messages` so boot-time collision detection
   sees it.
3. **Emit** after every mutation: `ctx.broadcast({ t: 'widgets.changed' })`.
4. **Consume** in exactly one client hook: `useLive(refresh, (msg) => msg.t === 'widgets.changed')`.

**Never write an exhaustive `switch` over `SpaServerMessage['t']`** in
`packages/*` or `apps/*`. The union is only as complete as the modules in this
build; equality predicates keep an open module set type-safe, and every existing
consumer already uses one.

To react to a message another module owns, use `isMessage(msg, 'other.changed')`
from `@moxxy/companion-core/client`: the tag is absent from your union because you do
not import that module's contract, and the reaction never fires when the owner is
absent.

## RBAC facts worth remembering

- `verify()` re-reads role and `disabled` from the account on **every** request,
  so a demotion takes effect immediately and no credential can outrank its
  account. Role, disable and password changes delete that user's sessions and
  managed API tokens.
- A permission leaves the grid the moment its owning module is disabled: routes
  503, `can()` goes false, and any UI gated on it must degrade rather than break.
  If you gate on a permission you do not own, declare it in the manifest's
  `consumes`.
- The install must always keep **at least one enabled account that holds
  `users:manage`**. That, not "one admin", is the invariant; the roles service
  refuses any change that would violate it and rolls the write back.
- Workspace membership is a second, independent gate. Role says *what kind of
  thing* you may do; workspace access says *whose data* you see. Keep them apart.

For the design behind instance-defined roles and grant overrides, read
`docs/internal/acl-and-roles.md`.
