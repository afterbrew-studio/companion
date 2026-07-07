import { z } from 'zod';
import type { MoxxyStatus } from '@companion/contract';
import { homeStatus, importProvidersFromDailyMoxxy, readHomeFile } from '../../moxxy/home.js';
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
const RUN_KINDS = ['interactive', 'triage', 'fix', 'analysis', 'implement', 'report'] as const;
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
            const raw = deps.store.getSetting(key);
            return raw ? (JSON.parse(raw) as string[]) : [];
          } catch {
            return [];
          }
        };
        // Provider names live in providers.json on older moxxy versions and in
        // config.yaml (plugins.provider.items) on current ones — read both, and
        // always include disabled leftovers so they stay visible.
        const names = new Set<string>();
        try {
          const raw = readHomeFile('providers.json');
          const parsed: unknown = raw ? JSON.parse(raw) : null;
          if (Array.isArray(parsed)) {
            for (const entry of parsed) {
              const name = (entry as { name?: unknown; provider?: unknown }).name ?? (entry as { provider?: unknown }).provider;
              if (typeof name === 'string') names.add(name);
            }
          } else if (parsed && typeof parsed === 'object') {
            for (const key of Object.keys(parsed as Record<string, unknown>)) names.add(key);
          }
        } catch {
          // unreadable providers.json — config.yaml below still contributes
        }
        for (const name of providerNamesFromConfigYaml(readHomeFile('config.yaml'))) names.add(name);
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
        deps.store.setSetting('disabledProviders', JSON.stringify(body.disabledProviders));
        deps.store.setSetting('disabledModels', JSON.stringify(body.disabledModels));
        return { ok: true };
      },
    }),

    route({
      method: 'GET',
      path: '/api/settings/model-pins',
      access: 'settings:manage',
      handler: () => ({
        pins: Object.fromEntries(RUN_KINDS.map((k) => [k, deps.store.getSetting(`modelPin:${k}`) || null])),
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
          deps.store.setSetting(`modelPin:${kind}`, model?.trim() ?? '');
        }
        return {
          pins: Object.fromEntries(RUN_KINDS.map((k) => [k, deps.store.getSetting(`modelPin:${k}`) || null])),
        };
      },
    }),

    route({
      // Instance branding: name + logo, public-readable via /api/auth/state.
      method: 'PUT',
      path: '/api/settings/branding',
      access: 'settings:manage',
      body: brandingSchema,
      handler: ({ body }) => {
        deps.store.setSetting('branding.name', body.name?.trim() ?? '');
        deps.store.setSetting('branding.logo', body.logo ?? '');
        return {
          branding: {
            name: deps.store.getSetting('branding.name') || null,
            logo: deps.store.getSetting('branding.logo') || null,
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
          githubConfigured: deps.github() !== null,
          githubUser: deps.githubUser(),
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
      handler: () => ({ reports: deps.store.listReports() }),
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

/**
 * Provider names from a moxxy config.yaml without a YAML dependency: the keys
 * one indent level under `plugins.provider.items`, plus the `default`. The
 * shape is stable moxxy config; anything unexpected just yields no names.
 */
export function providerNamesFromConfigYaml(yaml: string | null): string[] {
  if (!yaml) return [];
  const names = new Set<string>();
  let providerIndent = -1; // -1 = outside the provider block
  let itemsIndent = -1;
  let childIndent = -1;
  for (const line of yaml.split('\n')) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    // Leaving blocks: a sibling (or shallower) key closes the deeper scopes.
    if (providerIndent >= 0 && indent <= providerIndent) {
      providerIndent = -1;
      itemsIndent = -1;
      childIndent = -1;
    } else if (itemsIndent >= 0 && indent <= itemsIndent) {
      itemsIndent = -1;
      childIndent = -1;
    }
    if (providerIndent < 0) {
      if (/^provider:\s*$/.test(trimmed)) providerIndent = indent;
      continue;
    }
    if (itemsIndent < 0 && /^items:\s*$/.test(trimmed)) {
      itemsIndent = indent;
      continue;
    }
    if (itemsIndent < 0 && /^default:\s*\S/.test(trimmed)) {
      const value = trimmed.slice('default:'.length).trim();
      if (value) names.add(value);
      continue;
    }
    if (itemsIndent >= 0) {
      if (childIndent < 0) childIndent = indent; // first child fixes the item level
      if (indent === childIndent && trimmed.endsWith(':')) names.add(trimmed.slice(0, -1).trim());
    }
  }
  return [...names];
}
