import { defineServices } from '@moxxy/companion-core/server';
import { paths } from '@moxxy/companion-services';
import { SettingsStore } from './settings-store.js';
import { SessionsStore } from './sessions-store.js';
import { ApiTokensStore } from './api-tokens-store.js';
import { UsersStore } from './users-store.js';
import { RolesStore } from './roles-store.js';
import { AuditStore } from './audit-store.js';
import { AuditForwarder } from './audit-forwarder.js';
import { RolesService } from './roles-service.js';
import { Auth } from './auth.js';

/**
 * Construct module-core's stores + Auth and register them. `settings` is what
 * the kernel's `ctx.settings` proxy resolves to; `core` (the Auth instance) is
 * the authenticator the kernel wires into the router + the cross-module identity
 * service (verify / mintSession / userRole).
 */
export default defineServices((ctx) => {
  const settings = new SettingsStore(ctx.db);
  const sessions = new SessionsStore(ctx.db);
  const apiTokens = new ApiTokensStore(ctx.db);
  const users = new UsersStore(ctx.db, sessions);
  const roles = new RolesService(new RolesStore(ctx.db), users, ctx.rbac, ctx.setRoles, ctx.audit, ctx.log);
  // Before Auth, so the very first request already sees the stored roles rather
  // than the built-in-only grid the kernel starts with.
  roles.publish();
  const auth = new Auth(users, sessions, apiTokens, settings, ctx.rbac, roles);
  // Legacy .env accounts seed an EMPTY user store once; afterwards the Users
  // module owns accounts. A clean install with no .env runs SPA onboarding.
  auth.seedFromEnv(ctx.config.users);
  if (ctx.config.authMode === 'local') {
    const seeded = auth.seedLocalAdmin();
    if (seeded) ctx.log.info(`trusted local mode: created internal superadmin '${seeded}'`);
  } else if (auth.setupNeeded()) {
    const source = auth.prepareBootstrap(ctx.config.bootstrapToken ?? null, paths.bootstrapToken());
    ctx.log.info(
      source === 'environment'
        ? 'no accounts yet — first-boot onboarding requires COMPANION_BOOTSTRAP_TOKEN'
        : `no accounts yet — first-boot token written to ${paths.bootstrapToken()}`,
    );
  } else {
    auth.prepareBootstrap(null, paths.bootstrapToken());
  }
  ctx.services.register('roles', roles);
  // Same instance the kernel writes through via provideAudit; registering it
  // lets the routes read the trail without a second handle on the table.
  // Outbound stream alongside the table, not instead of it. Reads its target
  // live from module config, so turning a collector on or off needs no restart
  // and an unconfigured instance sends nothing.
  const forwarder = new AuditForwarder(
    () => {
      const url = ctx.moduleConfig.get('auditForwardUrl');
      const secret = ctx.moduleConfig.get('auditForwardSecret');
      return {
        url: typeof url === 'string' && /^https?:\/\//i.test(url.trim()) ? url.trim() : null,
        secret: typeof secret === 'string' && secret ? secret : null,
      };
    },
    (message, meta) => ctx.log.warn(message, meta),
  );
  forwarder.start();
  ctx.services.register('audit', new AuditStore(ctx.db, (event) => forwarder.enqueue(event)));
  ctx.services.register('auditForwarder', forwarder);
  ctx.services.register('settings', settings);
  ctx.services.register('core', auth);
});
