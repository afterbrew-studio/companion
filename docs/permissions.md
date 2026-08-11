# Permissions and roles

Every capability is a permission declared by the module that owns it, in that
module's `src/api/acl.ts`. That file is the single authored source: the
manifest's `permissions` array and the contract's `PermissionRegistry` are
derived from it.

```sh
pnpm acl add code repos:archive --title "Archive repositories" --grant admin
pnpm acl sync            # re-derive after editing acl.ts by hand
pnpm acl check           # the CI gate
```

`pnpm acl check` fails on: drift between the three declaration sites; a
permission id, WS message tag, `ServiceMap` key, route or nav key/shortcut
claimed by two modules; a permission gated on but declared nowhere; a grant
naming a permission its module does not own; an id that is not
`<resource>:<verb>`; and any change to the effective grid not mirrored in
`docs/acl-grid.json`, so "this pull request changes who may do what" shows up in
review.

## Roles are instance data

`admin`, `maintainer` and `business` are seeded and cannot be deleted, but what
they hold is tunable, and you can add your own:

```sh
companion role list
companion role create release-manager --title "Release Manager" --from maintainer
companion role revoke maintainer prs:act      # maintainers may no longer merge
companion role reset  maintainer prs:act      # back to whatever the modules grant
companion acl explain maintainer prs:act      # why, naming the mechanism
```

The **Roles** admin page does the same with switches. Modules only ever grant to
the three built-ins, so adding a role never requires a module change.

If you lock yourself out, stop the daemon and run:

```sh
companion role repair --grant-admin <username>
```

## Design

The reasoning behind this model, including what it replaced and why, is in
[`internal/acl-and-roles.md`](internal/acl-and-roles.md) (internal working
document).
