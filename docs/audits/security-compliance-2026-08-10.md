# Security and compliance readiness audit — 2026-08-10

> Historical baseline. OIDC, container and secure-SDLC findings were advanced
> in the [company-pilot readiness review dated 2026-08-11](company-pilot-readiness-2026-08-11.md).
> Use the newer review for the current verdict; this document preserves the
> evidence and finding history that led to it.

## Executive verdict

Companion now closes the six release blockers that triggered this review:

1. password login is throttled and first-admin setup requires an operator-held,
   one-time capability;
2. credentials are encrypted by the default secret store and legacy plaintext
   rows migrate at boot;
3. built-in webhook and Jira delivery pin a validated DNS address;
4. browser credentials stay in an HttpOnly cookie and never enter JavaScript or
   a WebSocket URL;
5. executable pipeline steps fail closed unless they can run in a constrained,
   digest-pinned container; and
6. new password hashes use the OWASP scrypt profile `N=2^15, r=8, p=3`, while
   successful login upgrades the former profile.

This is an internal source and behaviour review, not a penetration test or
certification. Companion must not be described as “OWASP certified”, SOC 2
compliant, ISO 27001 certified or GDPR compliant on the basis of this report.

| Deployment | Decision | Conditions |
| --- | --- | --- |
| One maintainer, default `npx`, loopback only | **Suitable for intended use** | Trust the local OS account and everything able to read `COMPANION_HOME`. Never proxy or publish local-auth mode. |
| Private team deployment | **Suitable with operator controls** | Password/OIDC mode, HTTPS public URL, restricted daemon ingress, protected key and data backups, and executable steps left off unless their sandbox is deliberately operated. |
| Public internet beta | **Conditional** | All private-team controls, upstream abuse monitoring, secure reverse-proxy validation, prompt security updates and acceptance of the remaining session/OIDC/container findings. Independent DAST/pentest is still recommended before a broad launch. |
| Regulated enterprise / formal assurance | **Not compliance-ready** | Requires organisational evidence plus the open OIDC, container, SDLC, audit-integrity and privacy work below. |

No critical finding was identified. The previously open high findings SEC-01
through SEC-05 and SEC-07 are resolved for their stated product boundaries;
residual limitations are called out rather than hidden by the word “fixed”.

## Scope and baseline

Audited target:

- working tree based on `main` at commit `97c045e6`;
- published CLI version `0.11.6`;
- HTTP router/RBAC, local/password sessions, API tokens and first boot;
- OIDC, GitHub/webhooks, notification egress and MCP boundaries;
- SQLite/config credentials, backup/restore and legacy migration;
- agent/runtime/pipeline execution and remote runner transport;
- static browser serving, WebSocket admission and security headers;
- Docker and repository security/operations documentation.

The reference baseline is [OWASP ASVS 5.0](https://owasp.org/www-project-application-security-verification-standard/),
targeting practical Level 2 readiness rather than claiming verification. The
secure-development view uses [NIST SSDF 1.1 (SP 800-218)](https://csrc.nist.gov/pubs/sp/800/218/final).
Password parameters follow the current [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).

Out of scope:

- independent penetration testing, DAST, fuzzing and formal cryptographic review;
- a real production proxy, cloud account, GitHub organisation, runner fleet,
  Vault/KMS, SIEM or endpoint-management policy;
- employee access reviews, incident/restore exercises, vendor due diligence,
  DPIA/DPA work, legal opinions and other organisational controls;
- assurance for third-party or out-of-tree modules, which execute as trusted
  server/browser code.

## Trust model

### Local mode

Default `npx @moxxy/companion` mode is a trusted-local appliance. It binds only
to loopback, creates a real internal superadmin and mints a normal expiring
session through a route that verifies loopback Host/Origin and rejects
cross-site fetch metadata. The trusted principal is the local OS account. A
process able to read `COMPANION_HOME` can already read repositories, state and
the owner-only CLI credential.

### Password/network mode

Networked installs use password or OIDC authentication. Docker pins password
mode even if a volume once belonged to a local install. The daemon itself speaks
HTTP; TLS termination, direct-port firewalling and preservation of the external
Host header are operator responsibilities. `COMPANION_PUBLIC_URL=https://…`
enables Secure cookies and HSTS.

### Execution and extension boundary

Repository text, pull requests, model output, MCP responses and inbound webhooks
are untrusted data. Executable pipeline definitions are reviewed privileged
code. Agent harnesses and external modules are also code-execution boundaries;
permission checks and review-then-apply reduce authority, but do not make an
arbitrary process or module safe.

## Resolved findings

### SEC-01 — resolved for single-node password authentication

Implemented:

- failed login is limited by normalized identity plus socket peer (5 attempts
  per 15 minutes) and by socket peer alone (30 per 15 minutes);
- limiter storage is bounded to 10,000 keys and `429` responses carry
  `Retry-After`; mutating refusals pass through central audit;
- unknown and disabled accounts perform the same real scrypt operation as an
  invalid password, reducing username timing disclosure;
- a networked empty instance accepts its first administrator only with a random
  one-time token of at least 32 characters, from the environment or an
  owner-only file; the file is deleted immediately after use;
- scrypt hashes serialize their parameters, reject hostile oversized parameters
  and use `N=32768, r=8, p=3`; legacy `s2` hashes rehash after successful login.

Residual: the limiter is process-local, so restart clears it and a shared proxy
shares the coarse socket-address bucket. Companion is single-node, but a public
deployment should still enforce an upstream rate limit and alert on repeated
`401`/`429` audit events. MFA and per-session inventory/revocation remain open
product work (SEC-13).

### SEC-02 — resolved for stored credentials

The default SQLite `SecretStore` now uses AES-256-GCM with a random 96-bit nonce
and `(module id, key)` as authenticated additional data. A 32-byte key is read
from `COMPANION_SECRET_KEY`, `COMPANION_SECRET_KEY_FILE`, or generated in an
owner-only file outside the database. Bad ciphertext or a wrong key fails boot.

Legacy plaintext config is eagerly rewritten. GitHub PATs/App private keys,
repository webhook HMAC keys and remote-runner tokens were also moved out of
their domain tables into the same secret seam; the old columns retain only an
opaque marker for schema compatibility. Integration, provider, MCP and pipeline
credentials already use that seam. Regression tests inspect SQLite and exercise
legacy migration and wrong-key refusal.

Database backup output explicitly excludes the key, and restore refuses a
snapshot containing encrypted secrets when no key is available.

Residual: the generated key and database share the same local data directory,
so this protects a database-only copy, not host/root compromise or a full-volume
backup containing both. Repository clones, transcripts and logs are operational
data, not encrypted by the application. Managed deployments should mount the
key separately or install the external secret-store provider and apply volume/
backup encryption.

### SEC-03 — resolved for built-in outbound webhooks and Jira

Every DNS answer is validated against loopback, private, link-local, reserved,
documentation, transition and metadata-capable ranges. Production delivery then
uses a request-local undici dispatcher whose lookup returns the approved address
while the original URL preserves HTTP Host, TLS SNI and certificate validation.
Redirects are never followed.

When an HTTP proxy is configured, delivery fails closed unless
`COMPANION_TRUST_EGRESS_PROXY=1` explicitly asserts that the proxy enforces the
same SSRF policy. The flag does not configure or validate the proxy.

The same shared transport now protects Slack, Discord, ntfy, generic webhooks,
Jira Automation, and Jira Cloud API calls. Jira Cloud additionally restricts
credential-bearing site URLs to `*.atlassian.net`. Private/LAN destinations are
not supported by built-in providers; an egress proxy is the explicit policy
boundary for managed networks.

### SEC-04 — resolved for the browser session transport

- login, setup, local bootstrap and OIDC issue `HttpOnly; SameSite=Strict;
  Path=/` cookies, adding `Secure` when the public URL is HTTPS;
- login responses contain user metadata and expiry, never the raw token;
- the SPA keeps only an in-memory “session observed” bit; no bearer credential
  is stored in localStorage/sessionStorage;
- WebSocket upgrades authenticate from the cookie, require an exact same-origin
  Host match and refuse scoped API tokens; the URL is simply `/ws`;
- every non-bearer mutation, including login/setup before a cookie exists,
  requires a custom CSRF header; cross-origin forms cannot set it and Companion
  exposes no permissive CORS response;
- the static server emits hashed-script CSP, frame/object/base restrictions,
  referrer, MIME-sniffing, permissions and same-origin resource policy headers;
  HTTPS public URLs also emit HSTS;
- unexpected exceptions are logged server-side and return only
  `internal server error`.

Residual: external browser modules are trusted same-origin code and can perform
actions with ambient cookies even though they cannot read the token. Artifact
signing and an explicit install trust ceremony remain open (SEC-14).

### SEC-05 — executable pipeline isolation implemented

Executable and `npm-bootstrap` steps remain disabled by default. Enabling them
also requires the split author/run permissions and a pre-pulled OCI image pinned
by SHA-256 digest. They never fall back to the daemon shell and are refused by
remote runners whose isolation cannot yet be attested.

The daemon invokes Docker with:

- `--pull never`, ephemeral removal and init;
- read-only root, all capabilities dropped and `no-new-privileges`;
- host non-root uid/gid, bounded PIDs, CPU, memory and `/tmp`;
- only the selected worktree mounted read-write at `/workspace`;
- an allowlisted Docker-client environment; secret values are supplied through
  process environment, not command arguments;
- network `none` by default; host/default/bridge networks are refused.

Each container receives an unguessable name. Timeout, cancellation and daemon
shutdown kill the Docker client process group and also force-remove that named
container; otherwise a detached daemon-side container could outlive its client
while retaining a publishing credential.

Residual: an operator-created named network is not automatically safe; publishing
requires an actual registry/DNS egress policy. The Docker socket remains a
privileged host boundary. General AI harness execution has its own fences but is
not yet the same ephemeral container sandbox (SEC-08).

### SEC-07 — HTTP baseline implemented

The HTTP server has regression coverage for CSP hashes and baseline headers,
and generic 500 responses no longer expose paths/SQL/upstream details. Secure
cookie/HSTS behaviour follows the configured HTTPS public URL. Direct TLS and
reverse-proxy correctness remain deployment responsibilities, documented in
the install and security guides.

## Controls retained from the original review

- Dynamic routes declare access and central RBAC enforces it. Permission arrays
  are AND requirements; scoped tokens cannot silently widen through `any` routes.
- Disabled users, role/password changes and deletion revoke sessions and managed
  API tokens. API tokens are hashed, permission-scoped, expiring and reveal
  plaintext only once.
- DTOs are shared, request bodies are Zod-validated/bounded, GitHub webhook HMAC
  uses exact raw bytes and delivery IDs are durable/bounded.
- Repository instructions are read from the checkout, GitHub writes use
  purpose-scoped accounts, and unattended changes follow review-then-apply.
- Mutating successes/refusals are audited at the router; OIDC sign-in records an
  explicit event. Audit retention/export/forwarding are configurable.
- State files inherit `umask(077)` and explicit `0600` where credentials are
  written. Worktrees, scratch and run data have bounded cleanup policies.
- CI uses a frozen lockfile and npm releases use trusted-publishing OIDC with
  provenance rather than a repository npm token.

## Open findings

### SEC-06 — medium — OIDC verification needs defence in depth

OIDC uses state, PKCE, issuer/audience/expiry checks, one-time entries and safe
return paths, but does not yet verify ID-token signatures against rotating JWKS
or bind a nonce. Close with HTTPS issuer pinning, algorithm allowlists, JWKS
rotation tests, nonce validation and an MFA-capable policy.

### SEC-08 — medium/high by workload — agent and container least privilege

The control-plane and runner images still execute as root and general agent
harnesses are not placed in the new pipeline container sandbox. Close with
dedicated non-root images/users, explicit writable volumes/tmpfs, dropped
capabilities/read-only roots, seccomp/AppArmor guidance, and per-harness
conformance tests. Treat untrusted fork code plus broad agent tools/egress as a
high-risk workload until then.

### SEC-09 — medium — secure SDLC automation is incomplete

CI builds, tests, typechecks, checks RBAC and checks the SDK surface, but the
repository still needs a committed dependency-update policy, SAST, secret and
container scanning, SBOM generation/verification, minimal workflow permissions
and pinned action revisions with an update process.

### SEC-10 — medium — audit evidence is not tamper-evident

The application treats its SQLite trail as append-only, but a host administrator
can alter it. Forwarding is optional and best effort. Regulated operation needs
mandatory off-box/WORM collection, gap alarms/replay, protected time sync,
retention/legal hold and evidence-export exercises.

### SEC-11 — medium — local CLI credential remains broad and long-lived

The owner-only `cli-token` is an admin-equivalent reusable credential with a
long lifetime. Local mode already trusts the OS user, but the token can leak into
a full-home backup or support archive. Replace it with a rotating, purpose-scoped
local credential and explicit status/revoke commands.

### SEC-12 — medium — privacy is not one unified lifecycle

Individual stores have retention, but Companion lacks a complete data inventory,
tenant-wide retention/legal-hold policy, export/erasure workflow and verified
backup/third-party deletion. Those and controller/processor/legal-basis records
are prerequisites to a GDPR claim.

### SEC-13 — medium — browser-session and strong-auth administration

Account changes revoke relevant sessions, but users/admins cannot list and revoke
one browser session, require recent re-authentication for sensitive operations,
or enforce MFA outside an identity provider. Add those controls before an
enterprise authentication assurance claim.

### SEC-14 — medium — external module provenance

Out-of-tree modules are ABI-validated but not signature/provenance verified.
They run as trusted server code and same-origin browser code. Add signed manifests,
publisher trust/pinning and an explicit review ceremony before presenting the
module marketplace as safe for unreviewed third-party code.

## Compliance-readiness matrix

| Area | Readiness | Evidence | Remaining gap |
| --- | --- | --- | --- |
| ASVS architecture/access/API | Strong partial | Central RBAC, scoped tokens, typed/Zod boundaries, bounded bodies | Control-by-control independent ASVS verification |
| ASVS authentication/session | Good partial | throttling, strong/upgradable scrypt, capability bootstrap, cookie/CSRF/WS redesign | SEC-06, SEC-11, SEC-13 |
| ASVS data/crypto/communications | Good partial | AES-GCM secret store, DNS-pinned egress, webhook HMAC, HTTPS-only vendor endpoints | host/backup encryption, proxy/TLS operational verification |
| ASVS logging/error handling | Good partial | central audit, generic 500, retention/export/forwarding | SEC-10 and production SIEM evidence |
| NIST SSDF — Prepare/Protect | Partial | architecture/invariants, secret seam, frozen dependencies, trusted publishing | formal roles/policy/threat cadence, SEC-08/09 |
| NIST SSDF — Produce | Good partial | strict TypeScript, tests/build/ACL/SDK gates, review-then-apply | SAST/DAST/fuzzing and independent review |
| NIST SSDF — Respond | Early | private disclosure policy and dependency audit path | advisory/SLA/incident/SBOM exercises |
| SOC 2 / ISO 27001 support | Partial product support | RBAC, audit, retention, backup and deployment controls | organisation/process evidence plus SEC-08/09/10/13 |
| GDPR support | Early | self-hosting, per-user access, bounded stores | SEC-12 and legal/organisational evidence |

## Recommended next order

1. Validate a real HTTPS reverse proxy and perform an independent authenticated
   DAST/pentest before a broad public launch.
2. Move both control-plane and agent containers to non-root, least-privilege
   profiles; extend attested sandboxing to remote/general harness work.
3. Complete OIDC JWKS/nonce/MFA and browser-session administration.
4. Add CodeQL/SAST, secret/container/SCA scans, SBOMs and pinned CI actions.
5. Add tamper-evident off-box audit operation, then the privacy/data lifecycle.
6. Sign and pin external module provenance.

## Verification evidence

Recorded on 2026-08-10 from command output, not inferred from types:

- root `pnpm test`: passed across all 31 participating workspace projects;
  notable focused totals were core framework 47/47, services 53/53, Code
  194/194, Operate 297/297, Notify 23/23, Jira 4/4 and CLI 54/54;
- root `pnpm typecheck` and `pnpm build`: passed across all 31 participating
  workspace projects and the generated slim registries;
- `pnpm acl check`: 57 permissions across 20 modules, zero errors/warnings;
- `pnpm sdk:surface`: 284 symbols across five entry points, no break;
- `pnpm audit --prod`: no known vulnerabilities; `git diff --check`: clean;
- source scans found no browser credential in local/session storage or a
  WebSocket URL, and no live credential-shaped value in source changes (the two
  query-token hits are negative regression tests; the only npm-shaped string is
  explicitly fake evidence in a specification);
- a disposable real-daemon smoke proved: owner-only one-time bootstrap token,
  setup rejection without CSRF, successful one-time setup, no token in the JSON
  response, HttpOnly/SameSite cookie, bootstrap-file deletion, owner-only secret
  key, cookie-authenticated `/me`, CSRF-protected logout, and `429` plus
  `Retry-After` on the sixth failed login;
- a second disposable daemon proved password mode does not import the host
  operator's active `gh` credential. All disposable homes were removed after
  the checks;
- a disposable default CLI launch proved trusted-local mode boots without a
  login form, mints an ordinary HttpOnly session for its internal superadmin,
  serves the SPA with CSP and cleans up after shutdown;
- `pnpm version:check`: clean, with no publishable package requiring another
  release bump or ABI change;
- the deterministic headless-Chrome/CDP harness signed into a disposable
  password-mode daemon, drove the current overview, issues, pull requests,
  pipelines, runs and modules surfaces, and regenerated the checked-in README
  media from encrypted fixture credentials. The disposable home and browser
  profile were removed afterward.

External pentest, production proxy/container review, SIEM continuity and
restore/incident exercises remain pending organisational evidence.
