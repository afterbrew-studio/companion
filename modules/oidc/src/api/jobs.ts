import { defineJobs } from '@moxxy/companion-sdk/server';
import '../contract/index.js';

/**
 * The whole integration with the rest of Companion: register a sign-in method
 * while enabled, drop it when disabled. No kernel change, no core change, and a
 * build without this module simply shows a password form.
 */
let unregister: (() => void) | null = null;

export default defineJobs({
  onEnable: (ctx) => {
    unregister?.();
    unregister = ctx.services.get('core').registerProvider({
      id: 'oidc',
      // A getter, so the label is read live per request like the rest of the
      // config in routes.ts: a config edit shows up without a re-enable.
      get label(): string {
        return String(ctx.moduleConfig.get('label') ?? 'Sign in with SSO');
      },
      startUrl: '/api/oidc/start',
    });
  },
  onDisable: () => {
    unregister?.();
    unregister = null;
  },
});
