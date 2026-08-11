# Incident response runbook

This runbook covers suspected compromise, data disclosure, unauthorised agent
activity, supply-chain findings, audit gaps, and destructive integration
actions. Fill in the organisation-specific contacts before deployment.

## Contacts and authority

| Role | Name / private contact | Authority |
| --- | --- | --- |
| Incident lead | | declare severity, stop the pilot, approve recovery |
| Technical lead | | isolate Companion/runners and preserve evidence |
| Security/privacy lead | | scope disclosure and notification obligations |
| Pilot-company contact | | receive status and accept resumption |
| Legal/communications | | approve external/regulatory notices |

Use a private incident channel. Do not paste tokens, source, database files,
private keys, or full exploit logs into public issues or chat.

## Severity

- **SEV-1:** confirmed credential/repository/customer-data disclosure;
  unauthorised merge/publish/destructive action; host or runner compromise;
  loss of the audit trail during suspected malicious activity.
- **SEV-2:** credible but unconfirmed exposure; cross-workspace/repository access;
  unexpected executable/module activity; inability to revoke access; active
  HIGH/CRITICAL vulnerability with a reachable path.
- **SEV-3:** contained policy violation, scanner finding without a reachable
  path, delivery/audit degradation without evidence of misuse.

When uncertain, start one level higher and downgrade with evidence.

## First hour

1. Record UTC detection time, reporter, affected version/image digest, users,
   repositories, runners, integrations, and the first known indicator.
2. Stop new work: disable automations, refuse agent Git and GitHub writes, and
   stop/cordon affected runners. If containment cannot be performed safely in
   the UI, stop the Companion service.
3. Restrict proxy ingress to the response team. Do not destroy the instance or
   run broad cleanup yet.
4. Revoke or rotate exposed Companion API tokens, browser accounts/passwords,
   GitHub credentials, runner tokens, OIDC client secret, provider keys, webhook
   HMACs, integration credentials, audit-forwarding key, and the Companion
   secret key as applicable. Rotation of the Companion secret key requires a
   planned re-encryption/migration; isolate first rather than replacing it
   blindly.
5. Preserve read-only evidence: GitHub audit/delivery records, Companion audit
   export, collector logs, daemon/runner/proxy/container logs, image digest,
   configuration with secrets redacted, timestamps, affected commits, and a
   verified database backup plus separately protected key.
6. Open a private security advisory when the cause may be a Companion defect.
   Notify the pilot-company contact that investigation is active; do not claim
   scope before it is known.

## Investigation

Build a timeline in UTC and answer:

- What principal, token, host, route, repository, runner, integration, or module
  performed the action?
- Was central RBAC bypassed, misconfigured, or correctly enforcing an overly
  broad role?
- Did data leave through GitHub, a model/runtime provider, a notification/Jira
  integration, audit forwarding, logs, backups, or an external module?
- Are audit-forwarding drop counts or timestamp gaps present? Backfill from the
  local NDJSON export and preserve both versions.
- Was untrusted repository text treated as instructions, or was code executed
  outside the digest-pinned pipeline sandbox?
- Which copies, backups, forks, messages, or vendor systems now hold the data?

Maintain an evidence log with collector, hash, timestamp, storage location, and
every transfer. Work on copies; preserve originals.

## Eradication and recovery

1. Patch or configure the root cause and obtain review from someone other than
   the implementer.
2. Rebuild from a pinned release/image rather than modifying the affected
   container in place. Verify checksums, npm provenance, SBOM, and scanner gates.
3. Restore in isolation when integrity is uncertain, following the
   [restore drill](restore-drill.md). Reconnect repositories, runners, and
   integrations one at a time with new least-privilege credentials.
4. Start in observation mode (`agentGitWrite=refused`,
   `agentGitHubWrite=refused`, executable pipelines off) and reconcile GitHub
   authoritative state with Companion's cache.
5. Validate identity, denied RBAC action, audit forwarding, backup, and the
   original exploit path before resuming.

The incident lead and pilot-company contact both approve resumption. Preserve a
written reason if a residual risk is accepted.

## Notification and post-incident work

The organisation's security/privacy/legal owners decide contractual,
regulatory, user, and public notification deadlines. Companion does not infer
those obligations.

Within five business days of containment, record root cause, affected data and
principals, timeline, detection/containment/recovery duration, credential and
data-copy disposition, corrective owners/dates, missing telemetry, and whether
the pilot gate or threat model changes. Exercise the corrective control and
attach evidence before closing the incident.
