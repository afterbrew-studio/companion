# Data lifecycle and privacy inventory

Companion is self-hosted, but self-hosted does not mean data-free. Repository
content, identity records, prompts, model output, delivery payloads, and audit
events may still be personal or confidential data. The deploying organisation
decides its legal basis, notices, retention, data-subject process, subprocessors,
and regional requirements. This document is product evidence, not legal advice
or a GDPR claim.

## Primary inventory

| Data class | Default location | Default lifecycle | Export / deletion boundary |
| --- | --- | --- | --- |
| Users, roles, browser sessions, API-token metadata | `companion.db` under `COMPANION_HOME` | Browser sessions expire after 7 days (an optional idle timeout can end them sooner); account disable, role/password change, and deletion revoke relevant sessions/tokens | Administrators manage users/tokens. Each user lists and revokes their own sessions; `users:manage` lists a user's sessions and revokes them all. |
| Encrypted credentials and integration secrets | Ciphertext in `companion.db`; key from `COMPANION_SECRET_KEY(_FILE)` | Kept while the connection/module/account exists; legacy plaintext is migrated at boot | Delete the owning connection/account/module configuration. Database deletion is not enough if backups or vendor-side credentials remain; rotate/revoke at the issuer. |
| Repository, issue, PR, CI, specification, planning, and workflow state | `companion.db`; GitHub remains authoritative for GitHub objects | Feature records remain until their owner deletes them or the instance/database is removed, except bounded feature ledgers described below | Feature APIs/UI provide operational access, not a tenant-wide privacy export/erasure API. GitHub-side data must be handled at GitHub too. |
| Repository clones and worktrees | `COMPANION_HOME` or the selected runner home | Finished worktrees: 3 days by default. Active and review work is protected. Clones are reusable cache/state and may remain until the repository or home is removed. | Delete through repository/run lifecycle where available; final decommission removes the managed roots on every runner. Never treat a DB-only restore as clone recovery. |
| Scratch directories and run gateway/session files | daemon or runner managed roots | Finished scratch: 24 hours; reaped runtime transcripts/configuration: 30 days by default. Active work is protected. | Retention is configured on module `operate` and enforced on reachable runners. A disconnected runner must be cleaned separately. |
| Agent prompts, transcripts, findings, token/cost metadata | database plus runtime session files | Runtime files use the 30-day default above; durable run/review rows may remain as product history | Remove the owning run/repository/workspace where the product exposes deletion; otherwise include the database in the instance-level deletion request. Models/providers may have their own retention. |
| Notifications | `companion.db` | 30 days | Automatically pruned; vendor-delivered copies are controlled by the destination. |
| Notification delivery attempts | `companion.db` | 14 days | Automatically pruned. Slack, Discord, Jira, ntfy, or webhook destinations retain their own message/event copy. |
| Automation webhook delivery ledger and payload | `companion.db` | Completed: 30 days / 50,000 rows; failed: 90 days / 10,000 rows | Automatically pruned. GitHub retains the authoritative delivery/event history separately. |
| Audit events | `companion.db` and optional off-box collector | 365 days by default, configurable 7–3650 days | NDJSON export and off-box forwarding are available. Shorten retention only after required export/legal-hold decisions. Collector deletion is separate. |
| Logs | stdout or `companiond.log` for background CLI | Background CLI rolls at 5 MB with one previous file; supervisor/platform policy otherwise applies | Logs should not contain secrets, but may contain usernames, repository names, paths, errors, and operational metadata. Apply platform retention and access controls. |
| Database backups | Operator-selected storage | No automatic expiry; operator policy owns copies | `companion backup` contains the database, not clones, provider credentials, or the secret key. Delete all generations and recovery copies when the retention obligation ends. |
| Provider, forge, and SaaS-side data | GitHub, model/runtime provider, OIDC provider, Jira, Slack, Discord, CodeRabbit, Cursor, or configured webhook service | Vendor contract and configuration | Export/delete/revoke with the vendor. Companion cannot prove deletion from a third party. |

Feature-specific stores also use count bounds (for example evaluation history
and planner events) or time bounds (for example settled slop detections). These
bounds protect storage; they do not replace the organisation's approved
retention schedule.

## Data flow questions to answer before a pilot

For each enabled repository, runtime, and integration, record:

1. data owner and business purpose;
2. allowed repositories, branches, users, and data classifications;
3. whether source, issue text, prompts, or model output may leave the host;
4. every recipient/subprocessor, region, retention, and training setting;
5. the retention/deletion owner in Companion, backups, runners, and vendors;
6. the access/export/correction/deletion contact and response process;
7. legal hold or regulatory retention that overrides ordinary cleanup.

Do not put production credentials, customer datasets, regulated data, or
unredacted support bundles into the first pilot. Use synthetic or internally
approved repositories until the real data flow has been accepted.

## Backup and deletion semantics

`companion backup` creates a consistent database snapshot and checks its
integrity. It deliberately excludes:

- repository clones and worktrees, which can be reacquired from the forge;
- runtime/provider credential homes, which need their own protected recovery;
- the Companion secret key, which must be recovered separately.

Deleting a live row does not rewrite old backups, off-box audit collections, or
third-party systems. Every deletion request therefore needs a list of recovery
copies and recipients, an applicable retention/legal-hold decision, and evidence
when each copy is deleted or expires.

## Current product limitations

Companion does not yet provide a single tenant-wide privacy export, erasure
workflow, legal-hold engine, or verified third-party deletion receipt. It also
does not encrypt clones, transcripts, or logs at the application layer. Use
host/volume/backup encryption and treat these as residual requirements before
making a formal privacy or compliance claim.
