# Open items

What is genuinely not built, as of 2026-07-27, after P0 to P9 of
[`game-plan.md`](game-plan.md) landed.

The list is short on purpose. **Every mechanism from the plan exists**: build
profiles, generated registries, instance-defined roles, the audit trail with
retention and export, the entitlement gate, the single-node lock, the GitHub
endpoint and outbound proxy seams, the secret store seam, the OIDC reference
module, the published SDK, and out-of-tree modules on both the server and the
browser. What follows needs content or a decision, not a new mechanism, with one
exception (§5) that needs neither until a module asks for it.

Verified against the tree rather than remembered: each entry says what exists and
what does not, so nobody has to re-derive it.

---

## 1. GitHub App credentials `[the one that actually blocks someone]`

**Today:** personal access tokens only, per account, in the multi-account
registry `modules/code` owns.

**The problem:** an organisation on GitHub Enterprise Cloud with SAML SSO must
SSO-authorise each token, and an organisation that bans PATs outright cannot
connect at all. No workaround exists on our side; it is not a configuration
question.

**Why it is first:** every other item on this page is something an evaluator can
live without or supply themselves. This one ends the conversation.

**Shape of the work:** an installation-based credential (app id, private key,
installation id) alongside the PAT in the accounts registry, token minting with
the one-hour expiry that implies, and `gh` / clone paths taught to use it.
`COMPANION_GITHUB_API_URL` and `COMPANION_GITHUB_HOST` already exist, so the
endpoint half is done.

## 2. A commercial module `[business decision, not code]`

**Today:** the entitlement gate works and is verified in six states (no licence
and no key, valid licence with no key in the build, no licence with a key,
expired, a licence granting a different feature, valid), plus degradation:
a lapsed licence disables the module at boot while its tables and config stay
intact and the instance stays administrable.

**Missing:** any module to put behind it, and the private repo that would hold
one. See `docs/modular-distribution.md` §7, which is deliberately still
`[LATER]`: it is a repo and licensing decision, not an implementation.

## 3. A Vault or KMS secret backend `[a module, and now only a module]`

**Today:** `kind: 'secret'` config routes through a `SecretStore`. The default
keeps it in SQLite, `provideSecrets` swaps the backend, and the kernel moves
existing values across and deletes the originals so a swap does not silently
un-configure every module or leave plaintext behind. Three invariants are
covered by tests that fail when the behaviour is removed.

**Missing:** an implementation of the interface. Two rules for whoever writes
one: the provider's own credentials stay in the default store (a Vault module
cannot keep its Vault token in Vault), and an external store is not inside the
config transaction.

## 4. SAML `[declined, with a reason]`

Not an omission. SAML needs XML signature verification, which is a dependency
and a far larger attack surface than OIDC, and every provider Companion targets
(Okta, Entra ID, Auth0, Google Workspace, Keycloak) speaks OIDC. `modules/oidc`
is the reference implementation.

Revisit only for a customer who genuinely has no OIDC option, and copy the OIDC
module's shape rather than reinventing the handshake.

## 5. Install lifecycle for modules that are not just JavaScript

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
