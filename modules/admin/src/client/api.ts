import { post, put, request } from '@moxxy/companion-core/client';
import type { InstanceBranding, NotificationSettings } from '../contract/index.js';

/**
 * module-admin's REST surface, carved from the legacy `lib/api.ts`: the
 * instance-administration methods the Settings page drives — branding, the
 * notification default scope, and the GitHub token.
 * Some URLs are served by other modules; only the strings are shared. HTTP +
 * token plumbing lives in `@moxxy/companion-core/client`.
 */

export const adminApi = {
  setGithubToken: (t: string) => post<{ login: string }>('/api/settings/github', { token: t }),
  setBranding: (branding: { name: string | null; logo: string | null }) =>
    put<{ branding: InstanceBranding }>('/api/settings/branding', branding),

  // instance notification defaults (admin)
  getNotificationSettings: () => request<NotificationSettings>('/api/settings/notifications'),
  setNotificationSettings: (defaultScope: NotificationSettings['defaultScope']) =>
    put<NotificationSettings>('/api/settings/notifications', { defaultScope }),

  /** Wipe the database and restart the daemon into first-boot setup. */
  recreateDb: () => post<{ ok: true }>('/api/settings/recreate-db'),
};
