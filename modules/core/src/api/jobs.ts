import { chmodSync } from 'node:fs';
import { defineJobs } from '@moxxy/companion-core/server';
import { paths, readRegularTextFile, writePrivateTextFile } from '@moxxy/companion-services';

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
 * It carries the primary admin's identity, so it is an ADMIN-EQUIVALENT local
 * bootstrap credential. Remote or least-privilege CLI/MCP clients should use a
 * managed, expiring `cmp_…` token from Settings instead. COMPANION_HOME already
 * holds the database itself, so this file does not widen that directory's blast
 * radius.
 */
const DAY_MS = 24 * 60 * 60_000;

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
    {
      id: 'core.api-tokens.prune',
      everyMs: DAY_MS,
      run: (ctx) => {
        const removed = ctx.services.get('core').pruneExpiredApiTokens();
        if (removed > 0) {
          ctx.log.info(`API tokens: pruned ${removed} expired credentials`);
          ctx.broadcast({ t: 'tokens.changed' });
        }
      },
    },
  ],
  postActivate: (ctx) => {
    const auth = ctx.services.get('core');

    const file = paths.cliToken();
    // A password/role change deletes the account's sessions, which would leave a
    // live-looking file holding a dead token. Re-mint instead of trusting it.
    try {
      if (auth.verify(readRegularTextFile(file, { maxBytes: 4_096, mode: 0o600 }).trim())) return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        ctx.log.warn(`could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const admin = auth.primaryAdminUsername();
    // First-boot onboarding has not created an account yet; the next start writes it.
    if (!admin) return;
    const { token } = auth.mintSession(admin, CLI_TOKEN_TTL_MS, 'full');
    writePrivateTextFile(file, `${token}\n`);
    // The create mode is subject to the umask; re-assert owner-only explicitly,
    // like readOrCreateBootstrapToken does on read.
    chmodSync(file, 0o600);
    ctx.log.info(`CLI token for '${admin}' written to ${file}`);
  },
});
