import { post, put, request } from '@companion/core/client';
import type { RunSettings } from '@companion/module-operate/contract';
import type { InstanceBranding, NotificationSettings } from '../contract/index.js';

/**
 * module-admin's REST surface, carved from the legacy `lib/api.ts`: the
 * instance-administration methods the Settings page drives — branding, the
 * notification default scope, run scheduling, the GitHub token, and the moxxy
 * provider import. Some URLs are served by other modules; only the strings are
 * shared. HTTP + token plumbing lives in `@companion/core/client`.
 */

export const adminApi = {
  importProviders: () => post<{ imported: string[]; missing: string[] }>('/api/moxxy/import-providers'),
  setGithubToken: (t: string) => post<{ login: string }>('/api/settings/github', { token: t }),
  setBranding: (branding: { name: string | null; logo: string | null }) =>
    put<{ branding: InstanceBranding }>('/api/settings/branding', branding),

  // instance notification defaults (admin)
  getNotificationSettings: () => request<NotificationSettings>('/api/settings/notifications'),
  setNotificationSettings: (defaultScope: NotificationSettings['defaultScope']) =>
    put<NotificationSettings>('/api/settings/notifications', { defaultScope }),

  // instance run-scheduling settings (admin)
  getRunSettings: () => request<RunSettings>('/api/settings/runs'),
  setRunSettings: (reservedRunnerSlots: number) =>
    put<RunSettings>('/api/settings/runs', { reservedRunnerSlots }),
};
