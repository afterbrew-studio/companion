# Open items

What is genuinely not built, as of 2026-07-28, after P0 to P9 of
[`game-plan.md`](game-plan.md) landed.

The list is short on purpose. **Every mechanism from the plan exists**: build
profiles, generated registries, instance-defined roles, the audit trail with
retention and export, the entitlement gate, the single-node lock, the GitHub
endpoint and outbound proxy seams, the secret store seam, the OIDC reference
module, the published SDK, out-of-tree modules on both the server and the
browser, GitHub App credentials, and the published ABI.

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

## 2. Publishing the module ABI `[BUILT]`

The six packages an out-of-tree module resolves types through are published:
`@moxxy/companion-sdk`, `-contracts`, `-core`, `-services`, `-types`, `-ui`.

**What made this hard, recorded because it is not obvious.** The first attempt
bundled the private framework declarations into the SDK with
`dts-bundle-generator`. The output was self-contained and **silently wrong**:
`@moxxy/companion-core` depends on the open registries, so inlining core inlined
`PermissionRegistry` with it, and a module augmenting `@moxxy/companion-contracts`
augmented one interface while `route({ access: ... })` read another. Measured by
packing both tarballs into a clean npm project: `Permission` resolved to `never`
and `access: 'hello:read'` was rejected. Marking contracts external does not
help, including as a real directory rather than a workspace link, because the
inlining is transitive.

Splitting the registries into a leaf package fails the same way, for the same
reason. So the framework is published instead, and the curation P8 exists for is
enforced where it always actually was:

- `companion module verify` allows an exact set of import specifiers, so a module
  importing `@moxxy/companion-core` is rejected before it is installed.
- The ABI bridge bridges only the SDK's three server entries, so at runtime
  anything reaching past them fails to resolve rather than getting a second copy.

**One packaging trap worth keeping.** `npm pack` leaves `workspace:*` literal, so
an npm-packed tarball installs nowhere; `pnpm pack` rewrites it to the resolved
version. Trusted publishing is an npm CLI feature. The workflow therefore packs
with pnpm and uploads that tarball with npm.

Verified the way the earlier attempt was disproved: all six packed, installed
into a clean npm project with no workspace links, and an out-of-tree module with
both a server and a client slice typechecked against them alone. The
augmentation lands, so `Permission` narrows to the declared id and rejects
anything else.

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

## Carried work

Not gaps in a mechanism, which is why they sit below the line. Each one is
started, decided or blocked on something nameable, and each is the kind of thing
that gets forgotten precisely because none of it stops a release.

**Installing a module by name.** `[BUILT]` `companion module add <spec>` fetches
an out-of-tree module, checks it against the ABI while it is still staged, and
writes `$COMPANION_HOME/modules/.provenance.json` recording the spec as typed,
the resolved name and version, the integrity hash and the registry. npm resolves
the spec, so private registries and their credentials work without Companion
knowing anything about them. It installs no dependencies, because `verify`
already requires entry chunks to import the ABI and nothing else.

What remains is the seam either side of it: the daemon scans `modules/` once at
boot, so adding files still needs a restart before `module install <id>` can see
them, and nothing reads the provenance ledger back out into the UI.

**Runner workforce policy.** In flight. Today `blockedTasks` is deny-only, so a
machine is open by default and a module update that registers a new task starts
running on a machine meant for one job. Needs an allow mode, module-level entries
that also cover tasks a module adds later, repository-level scope, and a decision
about the local runner: it is currently the last resort when nothing accepts a
task, which under an allow policy silently lands work on the daemon's own machine
exactly where the policy meant to keep it out.

**Adding a moxxy provider from the UI.** Provisioning a provider means reaching
the runner's shell. The seam exists on the moxxy side (`provision --spec -`,
`login --stdin-prompts`), so this is wiring and a credential-handling decision,
not a mechanism.

**The root README.** Carries content that belongs in separate files, and reads
as a document for people who already know what Companion is. The repository is
public, so this is the first thing a stranger sees.

**A trusted publisher for `@moxxy/companion-sdk`.** Operational, not code. The
other seven packages publish from CI; this one alone answers `404 Not Found` on
PUT, which npm also returns for "no permission", and it is the one package a
module author actually installs.

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
