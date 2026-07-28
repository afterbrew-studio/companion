# Open items

What is genuinely not built, as of 2026-07-28, after P0 to P9 of
[`game-plan.md`](game-plan.md) landed.

The list is short on purpose. **Every mechanism from the plan exists**: build
profiles, generated registries, instance-defined roles, the audit trail with
retention and export, the entitlement gate, the single-node lock, the GitHub
endpoint and outbound proxy seams, the secret store seam, the OIDC reference
module, the published SDK, out-of-tree modules on both the server and the
browser, and GitHub App credentials.

What follows needs content or a decision, not a new mechanism, with two
exceptions: §1 is built and kept here for its remaining rough edge, and §6 needs
nothing until a module asks for it.

Verified against the tree rather than remembered: each entry says what exists and
what does not, so nobody has to re-derive it.

---

## 1. GitHub App credentials `[BUILT]`

Was the one item that ended conversations. An account now connects either way:
a personal access token, or a **GitHub App installation** (App ID, Installation
ID, private key), which is what an organisation banning PATs or requiring
SSO-authorised tokens can actually use. Same registry, same purposes, same
per-repo resolution; only how the credential is obtained differs.

The shape worth knowing, because it is not the obvious one: `tokenFor` and
`clientFor` are **synchronous** and handed around as factories by a dozen call
sites, and `GitHubClient.headers()` is synchronous in every method. Making the
credential async to refresh something that changes once an hour would have
rippled through all of it. Instead the installation token is cached in the
account row with its expiry, a background job re-mints on a 25-minute margin
against a 10-minute interval (so one failed run still leaves a valid token and
another attempt), and `postActivate` refreshes at boot for the daemon that was
down longer than an hour.

Still open, and small: nothing surfaces "this installation stopped refreshing"
to an operator beyond a log warning. If an app is uninstalled on GitHub, the
account keeps its dead token until someone reads the log or a call fails over.
Worth a health field on the account record when someone hits it.

## 2. The module ABI cannot be published yet `[harder than it looks]`

**Today:** `@moxxy/companion-sdk` and `@moxxy/companion-contracts` both build and
both work in-repo. Neither is on npm, so the out-of-tree path is in-repo only.

**Why the obvious fix does not work.** The blocker is that their declarations
re-export from `@companion/core`, `/services`, `/types` and `/ui`, all private.
Bundling those into self-contained `.d.ts` files is the textbook answer, and it
was tried with `dts-bundle-generator`: the declarations do come out
self-contained, and they are **silently wrong**.

`@companion/core` depends on the open registries, so inlining core inlines
`PermissionRegistry` with it. The published SDK then carries its own copy, and a
module that augments `@moxxy/companion-contracts` augments one interface while
`route({ access: ... })` reads another. Measured end to end: packed both
tarballs, installed them into a clean npm project, and typechecked an
out-of-tree module against them alone. `Permission` came out as `never` and
`access: 'hello:read'` was rejected as not assignable to `RouteAccess`. Marking
contracts as an external import does not help, including when it is a real
directory rather than a workspace link: the inlining is transitive and reaches
the registries through core either way.

**So the real question is structural**, not a tooling choice: the registries have
to stay one interface in one package that every published declaration imports
rather than embeds. Options worth weighing, none of them free:

- Publish the framework packages too, and accept that `ModuleKernel`,
  `DynamicRouter` and `RbacGrid` become reachable. Undoes the curation of P8.
- Split the registries into a leaf package that `@companion/core` imports and
  that no bundling ever inlines, then bundle only what is above it.
- Generate the published declarations from the SDK's own source instead of
  re-exporting, so nothing transitive exists to inline.

What did land while proving this out: the packages moved to the `@moxxy` scope
(neither `@moxxy-ai` nor `@companion` exists on npm), and **the SDK no longer
re-exports the registries at all**. A module imports and augments them from
`@moxxy/companion-contracts`, which is one package owning one interface end to
end, and removes the duplication hazard from the in-repo build as well.

## 3. A commercial module `[business decision, not code]`

**Today:** the entitlement gate works and is verified in six states (no licence
and no key, valid licence with no key in the build, no licence with a key,
expired, a licence granting a different feature, valid), plus degradation:
a lapsed licence disables the module at boot while its tables and config stay
intact and the instance stays administrable.

**Missing:** any module to put behind it, and the private repo that would hold
one. See `docs/modular-distribution.md` §7, which is deliberately still
`[LATER]`: it is a repo and licensing decision, not an implementation.

## 4. A Vault or KMS secret backend `[a module, and now only a module]`

**Today:** `kind: 'secret'` config routes through a `SecretStore`. The default
keeps it in SQLite, `provideSecrets` swaps the backend, and the kernel moves
existing values across and deletes the originals so a swap does not silently
un-configure every module or leave plaintext behind. Three invariants are
covered by tests that fail when the behaviour is removed.

**Missing:** an implementation of the interface. Two rules for whoever writes
one: the provider's own credentials stay in the default store (a Vault module
cannot keep its Vault token in Vault), and an external store is not inside the
config transaction.

## 5. SAML `[declined, with a reason]`

Not an omission. SAML needs XML signature verification, which is a dependency
and a far larger attack surface than OIDC, and every provider Companion targets
(Okta, Entra ID, Auth0, Google Workspace, Keycloak) speaks OIDC. `modules/oidc`
is the reference implementation.

Revisit only for a customer who genuinely has no OIDC option, and copy the OIDC
module's shape rather than reinventing the handshake.

## 6. Install lifecycle for modules that are not just JavaScript

`docs/modular-distribution.md` §14, still `[LATER]` and correctly so.

Install is one atomic kernel call today: validate config, run migrations,
register services, mount routes, activate. That holds because every module ships
JavaScript and nothing else. A module carrying a native binary, requiring `git`
on PATH, or needing to reach a licence server breaks all three assumptions and
would need a real requirement-check phase.

Nothing needs doing until such a module exists. The design is written down so
the first one does not get an ad-hoc answer.

---

## Not on this list, and why

- **Multi-node / active-active.** Decided against, not deferred.
  `ENTERPRISE.md` §2 and `docs/modular-distribution.md` §11: the binding
  constraint is the local filesystem (clones, worktrees, moxxy home), not the
  database, so Postgres would be necessary and nowhere near sufficient.
  Execution already scales through `companion-runner`. `InstanceLock` enforces
  the decision by refusing a second daemon on the same home.
- **An `edition` manifest field.** Build profiles say which modules ship and
  `entitlement` says which are licensed. A third axis would be a second way to
  say the same thing.
- **Backup and restore tooling.** One SQLite file plus its `-wal`, and the
  procedure is in `ENTERPRISE.md` §2. Worth a script only if the procedure grows.
