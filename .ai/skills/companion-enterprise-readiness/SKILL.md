---
name: companion-enterprise-readiness
description: >-
  The enterprise bar for any Companion change: custom roles vs the closed Role
  union, pluggable authentication, the router as a central audit choke point,
  the secrets provider seam, air-gapped operation, license degradation, and
  backup / upgrade safety. Use when building an enterprise module, when a change
  touches auth / RBAC / secrets / audit / config, or when judging whether a
  feature is deployable in a regulated or air-gapped environment. Complements
  companion-security (trust boundaries) and companion-contract-and-rbac
  (threading a permission).
---

# Enterprise readiness

The bar an enterprise deployment sets, and which of those things a **module**
can carry versus which are **core** changes. Getting that split wrong produces a
module that reaches into core and breaks the OSS build.

Source of truth: `docs/acl-and-roles.md` (ACL, permissions, roles),
`docs/modular-distribution.md` §10 and §11 (the rest), and `docs/game-plan.md`
for what is scheduled when.

## Rule zero: is this a module or a core change?

A module cannot open a closed union in `packages/types`, cannot replace the
kernel's single `Authenticator`, and cannot retrofit a hook onto the router.
If the feature needs any of those, it is core work that belongs in the OSS repo
even though enterprise is what pays for it.

**Built, use them rather than rebuilding them:**

- **Custom roles.** Roles are instance data. Modules grant to the three built-in
  roles only; instance admins compose custom roles from the permission catalogue
  and an explicit revoke beats any module grant. Your `acl.ts` never mentions a
  custom role. See `docs/acl-and-roles.md`.
- **Audit log.** The router records every mutating request, refusals included,
  through `provideAudit`. Add `ctx.audit.record(...)` only for a decision no
  single route describes; never instrument a handler for coverage's sake.
  Retention is `auditRetentionDays` with a bounded daily sweep; `GET /api/audit`
  and `/api/audit/export` sit behind `audit:read`, so an auditor role can read
  the trail and nothing else.
- **SSO.** `modules/oidc` is the working reference: Authorization Code + PKCE
  (S256) + single-use `state`, identity read from userinfo, `iss`/`aud`/`exp`
  checked. Copy its shape for another protocol rather than reinventing the
  handshake. Provisioning is off by default and refuses any role holding
  `users:manage`; do not work around that.
- **Secret storage.** `kind: 'secret'` config routes through a `SecretStore`.
  The default keeps it in SQLite; a module swaps the backend with
  `provideSecrets`, and the kernel moves existing values across and deletes the
  originals. Two rules if you write one: the provider's own credentials stay in
  the default store (it needs them to reach its backend), and an external store
  is not inside the config transaction. See `packages/core/src/server/secret-store.ts`.
- **Entitlement gate.** `entitlement` on the manifest, offline Ed25519 licence.
- **GitHub endpoint seam.** `COMPANION_GITHUB_API_URL` / `COMPANION_GITHUB_HOST`
  drive the REST client, clones, `gh --hostname` and the UI's links.
- **Outbound proxy.** `installOutboundProxy()` at boot honours `HTTP_PROXY` /
  `HTTPS_PROXY` / `NO_PROXY` for everything that uses `fetch`. Never write a
  `fetch` against a hardcoded host: that is the bug that only surfaces at the
  customer.

**Still core work, in order of what they unlock:**

1. **A SAML module.** Deliberately not built: it needs XML signature
   verification, a dependency and a far larger attack surface than OIDC, which
   every provider Companion targets also speaks. Build it only against a
   customer who genuinely has no OIDC option.
2. **A Vault / KMS `SecretStore`.** The seam is built and tested; the backend is
   not. This is a module, not core work.
3. **Backup / restore / upgrade.** One SQLite file makes backup trivial. Write
   down the restore procedure and how far back a migration can roll before a
   customer asks.

## Air-gapped operation

Assume no outbound network. This is a hard requirement in the segments that pay
most, and it is cheap if designed in and expensive if retrofitted.

- License verification is **offline**: an Ed25519-signed file at
  `$COMPANION_HOME/license.jwt`, public key baked into the build. No license
  server call, ever.
- No telemetry, update check, or CDN fetch on a path that can block boot or a
  request. If any exists, it is opt-in and fails open and silently.
- Module install works from a local tarball and from a mounted directory, not
  only from a registry.
- The client loads no external fonts, scripts, or styles. Check this whenever you
  add a UI dependency.
- Every outbound call goes through the shared dispatcher and a configurable
  endpoint, so a proxy, a custom CA and a GitHub Enterprise host are one setting
  each rather than N. A `fetch` written straight at a hardcoded host is the bug
  that only surfaces at the customer.

## License degradation `[built]`

A manifest declares `entitlement: '<feature>'`; the kernel gates install and
enable on it and disables the module at boot when the licence lapses. Verified
behaviour, and the shape to preserve:

- The check runs at **install, enable and boot**, cached for a day. Never on a
  request path.
- A lapse **disables**, it does not brick: tables, stored config and the rest of
  the instance survive, everyone can still sign in, and renewing plus re-enabling
  restores the module with its configuration unchanged.
- Verification is **offline** (detached Ed25519 over a JSON payload at
  `$COMPANION_HOME/license.jwt`). No licence server, ever.
- An OSS build carries no issuer key and satisfies no entitlement: it fails
  closed rather than pretending it verified something.

When adding a gated module, put the entitlement on the manifest and nothing
else: never re-check it inside a handler, and never make a code path depend on
licence state, or a lapse turns into a crash instead of a clean disable.

Enforcement here is a contractual control with a technical speed bump, not a
security boundary. Do not write code comments, docs, or UI copy that imply
otherwise.

## Data handling

- **Retention is a feature, not a cleanup task.** Anything append-only (audit
  records, run transcripts, notifications, sync snapshots) needs a bounded
  retention policy and an index that makes the sweep cheap. See
  `companion-store-and-migrations`.
- **Export.** Enterprise wants audit and activity data out, in a format they can
  ingest. NDJSON over a permissioned route is enough; a bespoke integration is
  not.
- **Deletion.** When a user is removed, know what happens to rows that reference
  them. Decide it explicitly per table rather than discovering it in a DPA
  review.
- Secrets never cross to the client. `kind: 'secret'` redacts by omission, the
  read route returns a set/unset flag only, and `default` is forbidden. See
  `companion-security`.

## Multi-node: the answer is decided

**Companion is a single-node appliance.** Keep `better-sqlite3`, keep stores
synchronous, and write whatever SQLite SQL is clearest: there is no portability
constraint to respect and pretending otherwise costs clarity for nothing.

The reasoning, so you do not reopen it: the daemon holds clones, worktrees,
scratch and the moxxy home on local disk, so Postgres would be necessary for
multi-node and nowhere near sufficient. Execution already scales out through
`companion-runner`; the daemon is the control plane. HA is active/passive over a
shared volume.

What follows for your code:

- A second daemon on the same `COMPANION_HOME` refuses to start. Do not add a
  code path that assumes two daemons, and do not "fix" the lock.
- Scheduled jobs, sync loops and orchestration may assume they are the only
  instance. That assumption is now guaranteed, not hoped for.
- If a requirement genuinely needs active/active, that is a product decision, not
  a code change. Escalate it; do not start porting stores.

## Review checklist for an enterprise-facing change

- [ ] It is a module, and does not need a core change smuggled in with it.
- [ ] It names no OSS-side internals that the OSS build could drop; cross-edition
      access is `tryGet` / `ctx.bus`.
- [ ] Every mutation is permission-gated through `route({ access })` so the audit
      choke point sees it. No hand-rolled auth inside a handler.
- [ ] Entitlement is checked at enable time, not per request.
- [ ] Nothing on the boot or request path requires outbound network.
- [ ] New append-only tables have a retention policy and the index to enforce it.
- [ ] Secrets use `kind: 'secret'`; nothing sensitive reaches a DTO.
- [ ] Migrations are additive and idempotent, and `uninstall` leaves the database
      clean (`down()` or `purge(db)`).
- [ ] Degradation is graceful: license lapse, disabled dependency, and absent
      optional service each produce a clear state, not a crash.
