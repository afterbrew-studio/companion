import { z } from 'zod';
import { defineRoutes, route } from '@moxxy/companion-core/server';
import { requestDbRecreate } from '@moxxy/companion-services';
import type {
  NotificationScope,
  NotificationSettings,
  UpdateBrandingResponse,
} from '../contract/index.js';

const brandingSchema = z.object({
  name: z.string().trim().max(40).nullable(),
  // Logos are stored inline as data URLs; the client downscales before upload.
  logo: z
    .string()
    .regex(/^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/)
    .max(400_000)
    .nullable(),
});

/**
 * module-admin routes — the instance-admin settings surface carved out of the
 * daemon's monolithic `system.ts`. Pure reads/writes of core-owned settings
 * keys via `ctx.settings`; every route is gated by `settings:manage`.
 */
export default defineRoutes((ctx) => {
  // Single source of truth for the default-scope fallback (mirrors the core
  // SettingsStore helper, inlined here so admin needs no cross-module service).
  const notificationDefaultScope = (): NotificationScope =>
    ctx.settings.get('notifications.defaultScope') === 'global' ? 'global' : 'workspace';

  return [
    route({
      // Instance inbox default; each user may override it in their profile.
      method: 'GET',
      path: '/api/settings/notifications',
      access: 'settings:manage',
      handler: (): NotificationSettings => ({ defaultScope: notificationDefaultScope() }),
    }),

    route({
      method: 'PUT',
      path: '/api/settings/notifications',
      access: 'settings:manage',
      body: z.object({ defaultScope: z.enum(['workspace', 'global']) }),
      handler: ({ body }): NotificationSettings => {
        ctx.settings.set('notifications.defaultScope', body.defaultScope);
        ctx.broadcast({ t: 'admin.changed' });
        return { defaultScope: notificationDefaultScope() };
      },
    }),

    route({
      // The nuclear option: wipe the database and start over. Drops the
      // recreate marker and exits through the normal SIGTERM path — the
      // supervisor restarts the daemon, whose boot deletes the db files before
      // opening a fresh one (see consumePendingDbRecreate). First-boot setup
      // runs again; env-seeded accounts re-seed. Clones/worktrees are kept
      // (they're caches — re-added repos adopt them).
      method: 'POST',
      path: '/api/settings/recreate-db',
      access: 'settings:manage',
      handler: ({ user }) => {
        ctx.log.warn(`database recreation requested by ${user?.username ?? 'unknown'} — restarting`);
        requestDbRecreate();
        // Let the response flush before the shutdown starts tearing down.
        setTimeout(() => process.kill(process.pid, 'SIGTERM'), 300).unref();
        return { ok: true as const };
      },
    }),

    route({
      // Instance branding: name + logo, public-readable via /api/auth/state.
      method: 'PUT',
      path: '/api/settings/branding',
      access: 'settings:manage',
      body: brandingSchema,
      handler: ({ body }): UpdateBrandingResponse => {
        ctx.settings.set('branding.name', body.name?.trim() ?? '');
        ctx.settings.set('branding.logo', body.logo ?? '');
        ctx.broadcast({ t: 'admin.changed' });
        return {
          branding: {
            name: ctx.settings.get('branding.name') || null,
            logo: ctx.settings.get('branding.logo') || null,
          },
        };
      },
    }),
  ];
});
