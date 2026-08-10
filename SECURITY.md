# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through
[GitHub Security Advisories](https://github.com/moxxy-ai/companion/security/advisories/new).
Do not open a public issue and do not include real tokens, repository content,
customer data, private keys or exploit logs in a public channel.

Include the affected version or commit, deployment mode, minimal reproduction,
expected impact and any mitigations you already tested. We will acknowledge a
complete report, coordinate validation and remediation privately, and agree a
disclosure timeline with the reporter. This repository does not currently
promise a fixed response SLA.

## Supported versions

Until Companion publishes a stable release line, security fixes target the
latest released version and the default branch. Older prereleases may require
an upgrade rather than a backport. Published advisories will name the first
fixed version and any practical workaround.

## Deployment boundary

- Default `npx @moxxy/companion` mode trusts the local OS account and is valid
  only on a loopback bind. Never place local auth behind a proxy or expose it to
  another machine.
- Shared deployments must use password or OIDC authentication, set
  `COMPANION_PUBLIC_URL` to an HTTPS origin, terminate TLS at a controlled proxy,
  restrict direct access to the daemon port and protect `COMPANION_HOME`.
- The generated `secret-key` must be backed up separately from database
  snapshots. Application encryption protects a copied database without its key;
  it does not protect a compromised host or a backup containing both.
- Executable pipelines are disabled by default and require a digest-pinned,
  pre-pulled container sandbox. Networked execution additionally needs an
  operator-enforced egress policy.
- Out-of-tree modules execute as trusted server and browser code. Install only
  artifacts whose source and publisher you trust.

The current internal readiness review is
[`docs/audits/security-compliance-2026-08-10.md`](docs/audits/security-compliance-2026-08-10.md).
It is not a penetration test, certification, or claim of compliance with OWASP,
SOC 2, ISO 27001, GDPR, or another framework.
