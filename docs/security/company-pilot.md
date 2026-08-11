# Controlled company pilot gate

This gate is for a small, named company team evaluating Companion against
approved repositories. It is not permission to expose a default local instance
to the internet, process unrestricted customer data, or describe the product as
certified or compliant.

The pilot owner records an owner, date, and evidence link for every item. A box
without evidence is not complete.

## Supported pilot shape

- A Docker image built from the exact released commit, recorded by digest, and
  deployed as a single node behind a controlled HTTPS reverse proxy. The daemon
  port is reachable only from that proxy and health monitoring.
- Password authentication or the OIDC module. Trusted-local `npx` mode is not a
  network deployment mode.
- A named set of users, repositories, runners, notification destinations, and
  GitHub identities. No public self-signup.
- No out-of-tree modules and no executable pipeline steps during the first
  phase. General agent work is limited to trusted repositories; untrusted fork
  code is out of scope until the execution boundary receives independent
  review.
- Off-box audit collection, encrypted backups, a separate Companion secret key,
  and a tested stop/restore path.

## Go/no-go record

Copy this section into the pilot ticket and fill in the right-hand columns.

| Gate | Required evidence | Owner / date / link |
| --- | --- | --- |
| Release identity | Exact image digest, Companion version, GitHub Release, npm provenance, repository SBOM, and verified `SHA256SUMS` | |
| Network boundary | HTTPS URL, TLS scan, proxy config, firewall rule proving port 8901 is not directly reachable, and `COMPANION_PUBLIC_URL` matching the origin | |
| Container boundary | Non-root uid/gid 1000, read-only root filesystem, all capabilities dropped, `no-new-privileges`, bounded `/tmp`, and writable volumes owned only by uid 1000 | |
| Identity | Named administrators and users, auth mode, disabled public provisioning, tested login throttling, and one tested user/session revocation | |
| OIDC, when used | Exact issuer/client/redirect URI, allowed group or assigned users, `requiredAcr`, `maxAuthAgeMinutes`, provider MFA policy, and a successful plus rejected sign-in | |
| Authorization | Pilot-specific custom role, quarterly access-review owner, two controlled break-glass administrators, and an `acl explain` sample for a denied action | |
| GitHub | Dedicated least-privilege account/App, repository allow-list, protected branches, webhook HMAC, and proof that no unrelated repository is visible | |
| Execution | `allowExecutableSteps=false`, `agentGitWrite=refused`, `agentGitHubWrite=refused` for phase 1, no untrusted forks, and only approved dedicated runners | |
| Extensions | No out-of-tree module installed; `modules:deploy` removed from the pilot role | |
| Secrets | `COMPANION_SECRET_KEY_FILE` supplied outside `/data`, secret-manager owner and rotation procedure, encrypted storage/backup, and no secret in source or support bundles | |
| Audit | HTTPS `auditForwardUrl`, HMAC `auditForwardSecret`, collector verification, protected time sync, a received test event, zero unexplained forwarding drops, and an export/backfill owner | |
| Recovery | Successful isolated [restore drill](restore-drill.md), measured RPO/RTO, separate key recovery, and recovery of the provider-credential volume where required | |
| Data approval | Completed [data inventory](data-lifecycle.md), approved data classes and repositories, retention owner, deletion contact, and explicit exclusion of production customer secrets in phase 1 | |
| Incident readiness | Named incident lead and backup, private contacts, severity path, credential-rotation access, and a completed tabletop using the [runbook](incident-response.md) | |
| Independent testing | Authenticated DAST/reverse-proxy review scheduled; scope and safe test window agreed with the pilot company | |

The pilot is **no-go** while any row above is empty. Product maintainers may
accept a residual finding only in writing, with an owner, expiry date,
compensating control, and explicit acceptance from the pilot company.

## Safe starting configuration

The settings below deliberately make the first phase observational:

```sh
companion module config operate \
  --set agentGitWrite=refused \
  --set agentGitHubWrite=refused \
  --set worktreeRetentionDays=3 \
  --set scratchRetentionHours=24 \
  --set sessionRetentionDays=30

companion module config code --set allowExecutableSteps=false

companion module config core \
  --set externalSignup=false \
  --set auditRetentionDays=365 \
  --set auditForwardUrl=https://collector.example/companion
```

Set `auditForwardSecret` through the protected module configuration flow; do
not place it in a shell history. Use the Roles page to create the pilot role and
remove `modules:deploy`, user management, token administration, runner
management, and unsafe pipeline permissions unless the person's job explicitly
requires one of them.

For OIDC, require the assurance value used by the company's MFA policy and cap
authentication age. The exact value is provider-specific:

```sh
companion module config oidc \
  --set requiredAcr=urn:company:mfa \
  --set maxAuthAgeMinutes=480
```

## Expansion stages

### Phase 1 — observe

Companion may sync, analyse, draft, and show results. It may not push branches,
post comments, merge, execute user commands, or install external modules. Run
for at least five business days and review audit gaps, false positives, data
volume, spend, and incident alerts.

### Phase 2 — attended writes

Set `agentGitHubWrite=attended` only after phase 1 evidence is accepted. Keep
repository writes refused unless the company has reviewed the runner and
branch-protection path. Every externally visible action still requires a named
person to approve it.

### Phase 3 — limited automation

Allow a small number of repository-scoped automations with bounded budgets,
protected branches, delivery monitoring, and a documented rollback. Automated
GitHub writes and agent branch writes are separate decisions. Executable
pipelines remain off unless their digest-pinned container and egress network
have been independently reviewed.

## Stop conditions

Pause the pilot immediately when any of these occurs:

- suspected credential, repository-content, or personal-data disclosure;
- unexplained audit-forwarding drops or loss of collector continuity;
- access to a repository or workspace outside the approved set;
- an agent write outside the approved branch/action policy;
- unexpected executable or external-module activity;
- a HIGH/CRITICAL vulnerability without an accepted, time-bounded response;
- failed restore evidence, loss of the encryption key, or inability to revoke a
  principal;
- the pilot company asks for a stop.

Follow the incident runbook, preserve evidence, revoke credentials, and do not
resume until the pilot owner and company contact accept the corrective action.

## End-of-pilot cleanup

Export the agreed audit evidence, stop the instance, revoke Companion API,
GitHub, runner, OIDC, Jira, Slack, Discord, and provider credentials, delete
worktrees/clones/scratch data and unneeded backups, and obtain confirmation for
third-party deletion where the vendor retains data. Record what was retained,
why, where, who owns it, and its deletion date.
