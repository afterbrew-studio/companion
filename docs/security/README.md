# Security operations

These documents turn Companion's technical controls into an operator-owned
process. They are intentionally evidence-oriented: completing a checklist is
not a certification, and a feature existing in source is not proof that a
particular deployment operates it correctly.

| Guide | Use it for |
| --- | --- |
| [Company pilot gate](company-pilot.md) | deciding whether a specific company test may start, expanding it in stages, and stopping it safely |
| [Data lifecycle](data-lifecycle.md) | identifying stored data, retention, exports, deletion boundaries, backups, and third parties |
| [Incident response](incident-response.md) | triage, containment, evidence, recovery, notification, and post-incident work |
| [Restore drill](restore-drill.md) | proving that the database and its separately protected secret key can be restored |
| [Current readiness review](../audits/company-pilot-readiness-2026-08-11.md) | the dated product verdict, residual findings, and independent tests still required |

Start with the pilot gate. The other documents provide the evidence it asks
for. The public reporting and supported-version policy remains in
[`SECURITY.md`](../../SECURITY.md).
