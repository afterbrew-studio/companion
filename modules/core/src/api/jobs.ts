import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { defineJobs } from '@moxxy/companion-core/server';
import { paths } from '@moxxy/companion-services';

/**
 * Long enough that an unattended CLI never wakes up logged out. Revocation is
 * deleting the file (the next boot mints a fresh one) or changing the admin's
 * password, which drops every session that account owns.
 */
const CLI_TOKEN_TTL_MS = 10 * 365 * 24 * 60 * 60_000;

/**
 * module-core's lifecycle. The one job today is the local CLI's bearer token:
 * an ordinary hashed session row like any browser login, handed to the CLI
 * through a 0600 file in COMPANION_HOME rather than a password prompt.
 *
 * It carries the primary admin's identity, so it is an ADMIN-EQUIVALENT
 * credential. Per-token permission scopes need a role that grants only
 * `modules:manage`, which is not expressible until roles open up (see
 * docs/acl-and-roles.md §D1). COMPANION_HOME already holds the database itself,
 * so the file does not widen the blast radius of that directory.
 */
const DAY_MS = 24 * 60 * 60_000;

/** Only these mean "nothing but this machine can connect". */
function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

export default defineJobs({
  jobs: [
    {
      // Retention is a feature, not a cleanup task: an append-only table that
      // nobody sweeps is a disk-usage incident waiting for its first busy year.
      // The window is admin-configurable, the sweep is bounded per run, and
      // shortening it is destructive, which is why the config field says so.
      id: 'core.audit.prune',
      everyMs: DAY_MS,
      run: (ctx) => {
        const days = Number(ctx.moduleConfig.get('auditRetentionDays') ?? 365);
        const removed = ctx.services.get('audit').prune(days * DAY_MS);
        if (removed > 0) ctx.log.info(`audit: pruned ${removed} entries older than ${days} days`);
      },
    },
  ],
  postActivate: (ctx) => {
    const auth = ctx.services.get('core');

    // A first boot that only this machine can reach gets an admin outright,
    // rather than a form on a laptop where there is nobody to keep out. Gated on
    // the bind address: how the process was started says nothing about who can
    // connect to it. The credentials are shown on the sign-in screen, and stop
    // being shown the moment the password changes or the daemon is rebound.
    if (isLoopbackHost(ctx.config.host)) {
      const seeded = auth.seedLocalAdmin();
      if (seeded) {
        ctx.log.info(
          `local first boot: signed-in as '${seeded.username}' / '${seeded.password}' ` +
            '(shown on the sign-in screen; change it in Settings)',
        );
      }
    }

    const file = paths.cliToken();
    // A password/role change deletes the account's sessions, which would leave a
    // live-looking file holding a dead token. Re-mint instead of trusting it.
    if (existsSync(file)) {
      try {
        if (auth.verify(readFileSync(file, 'utf8').trim())) return;
      } catch (err) {
        ctx.log.warn(`could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const admin = auth.primaryAdminUsername();
    // First-boot onboarding has not created an account yet; the next start writes it.
    if (!admin) return;
    const { token } = auth.mintSession(admin, CLI_TOKEN_TTL_MS);
    writeFileSync(file, `${token}\n`, { mode: 0o600 });
    ctx.log.info(`CLI token for '${admin}' written to ${file}`);
  },
});
