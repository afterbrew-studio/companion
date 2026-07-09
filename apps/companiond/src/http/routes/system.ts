import { z } from 'zod';
import type { MoxxyStatus, NotificationSettings } from '@companion/contract';
import { configuredProviderNames, homeStatus, importProvidersFromDailyMoxxy } from '../../moxxy/home.js';
import { route, notFound, type CompiledRoute } from '../router.js';
import type { ApiDeps } from '../deps.js';

const importSchema = z.object({ sourceHome: z.string().optional() });
const ghTokenSchema = z.object({ token: z.string().min(10) });
const skillSchema = z.object({ content: z.string().max(64_000) });
const brandingSchema = z.object({
  name: z.string().trim().max(40).nullable(),
  // Logos are stored inline as data URLs; the client downscales before upload.
  logo: z
    .string()
    .regex(/^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/)
    .max(400_000)
    .nullable(),
});

/** Status indicators, provider import, GitHub PAT, reports, skills. */
const RUN_KINDS = ['interactive', 'triage', 'fix', 'analysis', 'implement', 'report', 'assistant'] as const;
const modelPinsSchema = z.object({
  pins: z.record(z.enum(RUN_KINDS), z.string().max(200).nullable()),
});

export function systemRoutes(deps: ApiDeps): CompiledRoute[] {
  return [
    route({
      // Providers + models as moxxy's gateway reports them (live or last-cached).
      method: 'GET',
      path: '/api/models-catalog',
      access: 'settings:manage',
      handler: () => deps.orchestrator.sharedModelCatalog(),
    }),

    route({
      method: 'GET',
      path: '/api/settings/providers',
      access: 'settings:manage',
      handler: () => {
        const parse = (key: string): string[] => {
          try {
            const raw = deps.store.settings.get(key);
            return raw ? (JSON.parse(raw) as string[]) : [];
          } catch {
            return [];
          }
        };
        // Configured provider names (shared helper — same set runners
        // advertise in health), plus disabled leftovers so they stay visible.
        const names = new Set<string>(configuredProviderNames());
        const disabledProviders = parse('disabledProviders');
        for (const name of disabledProviders) names.add(name);
        return {
          providers: [...names].sort().map((name) => ({ name, enabled: !disabledProviders.includes(name) })),
          disabledModels: parse('disabledModels'),
        };
      },
    }),

    route({
      method: 'PUT',
      path: '/api/settings/providers',
      access: 'settings:manage',
      body: z.object({
        disabledProviders: z.array(z.string().min(1).max(100)).max(100),
        disabledModels: z.array(z.string().min(1).max(200)).max(500),
      }),
      handler: ({ body }) => {
        deps.store.settings.set('disabledProviders', JSON.stringify(body.disabledProviders));
        deps.store.settings.set('disabledModels', JSON.stringify(body.disabledModels));
        return { ok: true };
      },
    }),

    route({
      method: 'GET',
      path: '/api/settings/model-pins',
      access: 'settings:manage',
      handler: () => ({
        pins: Object.fromEntries(RUN_KINDS.map((k) => [k, deps.store.settings.get(`modelPin:${k}`) || null])),
        defaultModel: deps.config.defaultModel,
      }),
    }),

    route({
      method: 'PUT',
      path: '/api/settings/model-pins',
      access: 'settings:manage',
      body: modelPinsSchema,
      handler: ({ body }) => {
        for (const [kind, model] of Object.entries(body.pins)) {
          deps.store.settings.set(`modelPin:${kind}`, model?.trim() ?? '');
        }
        return {
          pins: Object.fromEntries(RUN_KINDS.map((k) => [k, deps.store.settings.get(`modelPin:${k}`) || null])),
        };
      },
    }),

    route({
      // Instance inbox default; each user may override it in their profile.
      method: 'GET',
      path: '/api/settings/notifications',
      access: 'settings:manage',
      handler: (): NotificationSettings => ({
        defaultScope: deps.store.settings.notificationDefaultScope(),
      }),
    }),

    route({
      method: 'PUT',
      path: '/api/settings/notifications',
      access: 'settings:manage',
      body: z.object({ defaultScope: z.enum(['workspace', 'global']) }),
      handler: ({ body }): NotificationSettings => {
        deps.store.settings.setNotificationDefaultScope(body.defaultScope);
        return { defaultScope: deps.store.settings.notificationDefaultScope() };
      },
    }),

    route({
      // Instance branding: name + logo, public-readable via /api/auth/state.
      method: 'PUT',
      path: '/api/settings/branding',
      access: 'settings:manage',
      body: brandingSchema,
      handler: ({ body }) => {
        deps.store.settings.set('branding.name', body.name?.trim() ?? '');
        deps.store.settings.set('branding.logo', body.logo ?? '');
        return {
          branding: {
            name: deps.store.settings.get('branding.name') || null,
            logo: deps.store.settings.get('branding.logo') || null,
          },
        };
      },
    }),

    route({
      method: 'GET',
      path: '/api/status',
      access: 'any',
      handler: (): MoxxyStatus => {
        const home = homeStatus();
        return {
          cliPath: deps.moxxyCli?.path ?? null,
          cliVersion: deps.moxxyCli?.version ?? null,
          compatible: deps.moxxyCli?.compatible ?? false,
          homeDir: home.homeDir,
          homeReady: home.homeReady,
          providersImported: home.providersImported,
          // Instance-level health: is GitHub set up at all? Independent of who is
          // viewing (per-user account resolution must not flip the health dot).
          githubConfigured: deps.githubAccounts.list().some((a) => a.purposes.includes('fetch')),
          githubUser:
            (deps.githubAccounts.list().find((a) => a.ownerId === null && a.purposes.includes('fetch')) ??
              deps.githubAccounts.list().find((a) => a.purposes.includes('fetch')))?.login ?? null,
        };
      },
    }),

    route({
      method: 'POST',
      path: '/api/moxxy/import-providers',
      access: 'settings:manage',
      body: importSchema,
      handler: ({ body }) => importProvidersFromDailyMoxxy(body.sourceHome),
    }),

    route({
      method: 'POST',
      path: '/api/settings/github',
      access: 'settings:manage',
      body: ghTokenSchema,
      handler: async ({ body }) => {
        const viewer = await deps.setGithubToken(body.token);
        return { login: viewer.login };
      },
    }),

    route({
      method: 'GET',
      path: '/api/reports',
      access: 'reports:read',
      handler: () => ({ reports: deps.store.reports.list() }),
    }),

    route({
      method: 'GET',
      path: '/api/skills',
      access: 'skills:manage',
      handler: () => ({ skills: deps.skills.list() }),
    }),

    route({
      method: 'GET',
      path: '/api/skills/:name',
      access: 'skills:manage',
      handler: ({ params }) => {
        const skill = deps.skills.get(params.name);
        if (!skill) throw notFound(`skill ${params.name} not found`);
        return { skill };
      },
    }),

    route({
      method: 'PUT',
      path: '/api/skills/:name',
      access: 'skills:manage',
      body: skillSchema,
      handler: ({ params, body }) => ({ skill: deps.skills.save(params.name, body.content) }),
    }),

    route({
      method: 'DELETE',
      path: '/api/skills/:name',
      access: 'skills:manage',
      handler: ({ params }) => {
        deps.skills.remove(params.name);
        return { ok: true };
      },
    }),
  ];
}
