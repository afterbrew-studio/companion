import { defineServices } from '@companion/core/server';
import { SettingsStore } from './settings-store.js';
import { SessionsStore } from './sessions-store.js';
import { UsersStore } from './users-store.js';
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
  const users = new UsersStore(ctx.db, sessions);
  const auth = new Auth(users, sessions, settings, ctx.rbac);
  ctx.services.register('settings', settings);
  ctx.services.register('core', auth);
});
