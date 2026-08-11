# Company-pilot security readiness review — 2026-08-11

## Executive verdict

The current change set is suitable for a **small, controlled company pilot only
after the deployment-specific gate is completed**. It is not approval for a
public internet launch, untrusted fork execution, unreviewed extensions,
regulated production data, or a claim of OWASP, SOC 2, ISO 27001, or GDPR
compliance.

Since the 2026-08-10 review, Companion has closed the OIDC verification finding,
moved both shipped containers to a non-root runtime, added a read-only/default
least-privilege Compose profile, and built a secure-SDLC gate around dependencies,
source, workflows, images, and release artifacts. The remaining product gaps are
real, but a narrow pilot can compensate for them with off-box audit collection,
OIDC/provider MFA, no external modules or executable pipelines, trusted
repositories only, staged write authority, and tested recovery.

The operational decision and evidence template is
[`docs/security/company-pilot.md`](../security/company-pilot.md). A company
pilot is **no-go** until every row there has an owner, date, and evidence link.

## Scope and baseline

- Working tree based on commit `3144862f8b79`, CLI version `0.11.7`.
- OIDC discovery, token verification, claims, MFA binding, and key rotation.
- Docker control-plane and runner images plus the default Compose profile.
- GitHub Actions permissions/action provenance, dependency/SAST/container
  scanning, dependency updates, release SBOM and integrity artifacts.
- Existing authentication, secrets, egress, browser-session, executable-pipeline,
  RBAC, audit, retention, and backup controls from the 2026-08-10 review.
- Operational pilot gate, data inventory, incident response, and restore drill.

Out of scope remains independent penetration testing, authenticated DAST, a real
company proxy/IdP/SIEM/runner fleet, legal assessment, vendor due diligence,
employee processes, and formal control-by-control certification.

## Finding changes

### SEC-06 — resolved — OIDC verification

The OIDC client now:

- requires the discovery issuer to exactly match configured issuer and accepts
  only HTTPS endpoints (loopback HTTP remains a test/development exception);
- requires a signed ID token and verifies RS256 or ES256 against the provider's
  JWKS, matching `kid`, `alg`, key type/use/operations and EC curve;
- bounds and caches the JWKS, refreshes on an unknown key, and retries once on a
  same-`kid` rotation after an invalid signature;
- binds single-use state, PKCE, and nonce, and validates issuer, subject,
  audience/authorised party, expiry, not-before, issued-at, authentication age,
  optional required ACR, and a Bearer token type;
- requires userinfo `sub` to match the verified token subject.

The focused suite uses a real RSA-signed stub provider and covers valid sign-in,
forged keys, `alg=none`, nonce, audience/`azp`, time claims, subject substitution,
required ACR/max age, missing ID token, bad discovery, and key rotation.

Residual operation: the company IdP must enforce MFA and supply the ACR value the
deployment config requires. Companion cannot turn a weak upstream sign-in into
strong authentication by itself.

### SEC-08 — partly resolved — container and agent least privilege

Both images now run as uid/gid 1000. State and credential volumes are explicitly
writable by that account; state files use a restrictive umask. The Compose
profile has a read-only root filesystem, all Linux capabilities dropped,
`no-new-privileges`, and a bounded `noexec` tmpfs. The Node base image is digest
pinned and its npm payload is held to versions that pass HIGH/CRITICAL image
scanning.

The executable pipeline sandbox remains fail-closed, digest-pinned, read-only,
capability-free, resource-bounded, and networkless by default.

Residual: general AI harnesses are fenced by isolated working directories,
permission policy, token ceilings, protected branches, and review-then-apply,
but they are not yet attested ephemeral containers. Remote runner host isolation,
egress, seccomp/AppArmor and untrusted-fork behaviour still need independent
testing. The pilot therefore uses only trusted repositories, refuses repository
writes initially, and excludes untrusted fork code.

### SEC-09 — substantially resolved in source — secure SDLC

The repository now has:

- a policy test requiring explicit workflow permissions, forbidding
  `pull_request_target`, and requiring immutable SHA/digest pins for every
  external action/container action;
- frozen installs plus weekly production dependency audit;
- pull-request dependency/licence review and weekly Dependabot updates for npm,
  GitHub Actions, and Docker;
- CodeQL JavaScript/TypeScript `security-extended` analysis;
- Trivy HIGH/CRITICAL OS and application-library scanning of the deployable
  image, with unfixed findings reported and fixed findings blocking;
- GitHub vulnerability alerts, Dependabot security updates, secret scanning,
  push protection, and private vulnerability reporting enabled;
- a release that requires npm trusted-publishing provenance, exercises the exact
  registry tarball, requires an asynchronously generated SPDX 2.3 repository
  SBOM, and publishes checksums for integrity assets.

Residual: the first merged run of the new CodeQL/dependency-review/Trivy jobs is
still deployment evidence to collect. Secret scanning coverage depends on the
GitHub plan and configured pattern support. Authenticated DAST, fuzzing and an
independent penetration test are not provided by CI.

### SEC-10 — open with mandatory pilot compensation — audit integrity

Local audit remains append-only at the application layer, exportable, bounded,
and optionally HMAC-forwarded. A host administrator can still alter SQLite, and
forwarding is memory-buffered/best-effort rather than a durable replay queue.

Pilot compensation: forwarding to an access-controlled off-box collector is
mandatory; HMAC verification, protected time sync, gap/drop monitoring, local
NDJSON backfill ownership, collector retention, and a test event are required
before start. A silent or unexplained gap stops the pilot.

### SEC-11 — open, outside the network-pilot path — local CLI credential

Trusted-local mode retains its broad owner-only CLI credential. The company
pilot excludes local auth and uses password/OIDC network mode, so this credential
is not an accepted remote access path. Rotating/purpose-scoping the local
credential remains product work.

### SEC-12 — partly addressed by evidence, product workflow still open — privacy

The [data lifecycle inventory](../security/data-lifecycle.md) now identifies
primary locations, default retention, backups, third parties, deletion
boundaries, and current limits. The pilot requires approved data classes,
repositories, recipients, retention owners, and end-of-pilot cleanup.

Companion still lacks a tenant-wide export/erasure workflow, legal hold,
verified third-party deletion, and application-layer encryption for clones,
transcripts, and logs. These remain prerequisites to a privacy/compliance claim.

### SEC-13 — partly reduced — sessions and strong authentication

OIDC can now require the company's MFA assurance value and maximum authentication
age. Password login is throttled, sessions expire after seven days, and account,
password, role, disable, and deletion changes revoke relevant sessions/tokens.

Users/admins still cannot inventory and revoke one browser session or require a
fresh re-authentication for one sensitive action. For the pilot, use company MFA
through OIDC, named users only, short access reviews, and global account/session
revocation on suspected compromise.

### SEC-14 — open with mandatory pilot exclusion — extension provenance

Out-of-tree modules remain ABI-checked but unsigned trusted server/same-origin
browser code. No such module is permitted in the pilot, and the pilot role must
not hold `modules:deploy`. Publisher signing/pinning and an explicit trust
ceremony remain product work.

## Pilot residual-risk register

| Risk | Pilot control | Stop/expiry |
| --- | --- | --- |
| General agent process can execute tools with host/runner authority | trusted repos only; no untrusted forks; read-only phase; dedicated runners; protected branches | any out-of-policy command/write stops pilot; external runner review before expansion |
| Audit database is host-mutable and forwarding can drop | off-box HMAC collector, gap/drop alarm, backfill owner, protected time | any unexplained gap stops pilot |
| No per-browser session inventory/fresh re-auth | company OIDC MFA + max auth age, named short-lived pilot users, revoke account on suspicion | review after each phase; close before enterprise auth claim |
| No unified privacy erasure/legal hold | approved non-production data set, data owner, short pilot, explicit multi-system cleanup | pilot end or data-scope change |
| Unsigned external modules | none installed; no `modules:deploy` for pilot role | any external module blocks/resets pilot |
| Executable pipeline supply chain/egress | disabled in pilot | separate sandbox/egress review required before enabling |

## Independent evidence requested from the pilot company

1. Authenticated DAST and manual reverse-proxy review, including origin/Host,
   cookie, CSRF, WebSocket, body-size, rate-limit, TLS, and direct-port tests.
2. OIDC integration tests against the real IdP: MFA ACR, max age, disabled user,
   wrong tenant/audience, logout/revocation, and key rotation.
3. Runner and agent execution review: filesystem, credential, process, network,
   fork/PR prompt-injection, cancellation, timeout, and cleanup boundaries.
4. SIEM continuity exercise with a collector outage, visible drop/gap state,
   local export, backfill, HMAC verification, retention, and time correlation.
5. The isolated backup/restore drill and an incident-response tabletop, with
   measured RPO/RTO and credential rotation.
6. Data-flow/vendor review for GitHub, model runtimes/providers, OIDC, Jira,
   Slack/Discord and any review integration actually enabled.

Findings from these exercises must enter the private security process with
severity, owner, due date, affected versions, compensation, and retest evidence.

## Verification evidence

Evidence already observed on this change set:

- root `pnpm test`, `pnpm typecheck`, and `pnpm build` passed across all
  participating workspace projects; notable focused suites include OIDC 29/29,
  Code 194/194, core framework 47/47, core module 31/31, services 53/53,
  Operate 297/297, Notify 23/23, and CLI 54/54;
- `pnpm acl check` reported 57 permissions across 20 modules with no error or
  warning; the 284-symbol SDK surface, release package discovery, emitted
  package-dependency check, version check, production dependency audit,
  workflow syntax, Compose parsing, and diff check all passed;
- OIDC module typecheck plus 29 focused signed-token/JWKS and bounded-response tests passed;
- the 20-module full runtime and runner Docker targets built and booted as
  uid/gid 1000 with a read-only root, all capabilities dropped,
  `no-new-privileges`, and bounded `noexec` `/tmp`;
- generated database, key, and runner state were owner-only (`0600`);
- Trivy reported zero fixed HIGH/CRITICAL OS or library findings in both final
  images, including the optional Moxxy CLI installed in the full runtime;
- the workflow policy found all 21 remote action references immutable and
  explicit workflow permissions present;
- production dependency audit was clean;
- locally packed `contracts`, `core`, and `sdk` artifacts installed into an
  empty consumer project and every runtime SDK entry point imported without the
  monorepo supplying undeclared dependencies;
- GitHub repository security settings and asynchronous SPDX report generation
  were exercised through their APIs.

After push, retain the first green GitHub CI/CodeQL/dependency-review run as
remote evidence. The local results establish this source candidate; neither
they nor the hosted run replace the deployment-specific pilot gate.

## Decision

- **Default local use:** suitable for its loopback/trusted-OS-user boundary.
- **Controlled company pilot:** conditional go after every pilot gate row has
  evidence and all mandatory compensations are active.
- **Public internet/general beta:** no-go pending independent DAST/pentest and
  review of the production proxy/monitoring/runner environment.
- **Regulated production or formal compliance claim:** no-go pending closure or
  formal organisational treatment of SEC-08 and SEC-10 through SEC-14 plus a
  control-by-control independent assessment.
