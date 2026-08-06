import { z } from 'zod';
import { badRequest, created, defineRoutes, notFound, route } from '@moxxy/companion-sdk/server';
import '../contract/index.js';

const modelSchema = z.object({
  id: z.string().trim().min(1).max(200),
  label: z.string().trim().max(120).nullable().default(null),
  contextWindow: z.number().int().min(1).nullable().default(null),
  inputPerMTok: z.number().min(0).nullable().default(null),
  outputPerMTok: z.number().min(0).nullable().default(null),
  probed: z
    .object({
      ok: z.boolean(),
      tools: z.boolean(),
      streaming: z.boolean(),
      at: z.number(),
      detail: z.string().nullable(),
    })
    .nullable()
    .default(null),
  options: z.record(z.unknown()).nullable().default(null),
});

/**
 * `baseUrl` is administration, never derived from a prompt or a run argument,
 * which is what keeps an agent from pointing this instance at a host of its
 * choosing. Only http(s): the daemon fetches this URL server-side.
 */
const baseUrl = z
  .string()
  .trim()
  .url()
  .max(2_000)
  .refine((value) => /^https?:\/\//i.test(value), 'the endpoint must be an http(s) URL');

const createSchema = z.object({
  label: z.string().trim().min(1).max(80),
  kind: z.string().trim().min(1).max(60),
  baseUrl: z.union([baseUrl, z.null()]).default(null),
  apiKey: z.string().max(500).optional(),
  headers: z.record(z.string().max(2_000)).default({}),
  query: z.record(z.string().max(500)).default({}),
  apiVersion: z.string().trim().max(60).nullable().default(null),
  factoryOptions: z.record(z.unknown()).default({}),
  workspaceIds: z.array(z.string().min(1).max(100)).nullable().default(null),
  models: z.array(modelSchema).max(200).default([]),
  enabled: z.boolean().default(true),
});

// Empty means "leave the stored credential alone": the form is never shown it.
const patchSchema = createSchema.partial();

/**
 * `command` is executed on whichever machine runs the agent, so this is
 * administration in the strictest sense: it never comes from a prompt, a run
 * argument or anything a model produced, and `runtime:manage` is the same
 * permission that already configures where this instance sends its money.
 */
const mcpFields = z.object({
  label: z.string().trim().min(1).max(80),
  transport: z.enum(['stdio', 'http']),
  command: z.string().trim().max(500).nullable().default(null),
  args: z.array(z.string().max(500)).max(50).default([]),
  env: z.record(z.string().max(2_000)).default({}),
  url: z.union([baseUrl, z.null()]).default(null),
  headers: z.record(z.string().max(2_000)).default({}),
  secret: z.string().max(4_000).optional(),
  access: z.array(z.enum(['read-only', 'workspace-write', 'trusted-assistant'])).default([]),
  tools: z.array(z.string().min(1).max(200)).max(200).nullable().default(null),
  workspaceIds: z.array(z.string().min(1).max(100)).nullable().default(null),
  enabled: z.boolean().default(true),
});

const createMcpSchema = mcpFields
  .refine((value) => value.transport !== 'stdio' || (value.command ?? '').length > 0, {
    message: 'a stdio server needs the command that starts it',
    path: ['command'],
  })
  .refine((value) => value.transport !== 'http' || value.url !== null, {
    message: 'an http server needs the endpoint it is reached at',
    path: ['url'],
  });

/**
 * The same fields, all optional. A refinement cannot ride along, because these
 * two rules are about the WHOLE record and a patch only carries part of one;
 * the route applies them to the merged result instead. An absent key is omitted
 * rather than parsed to undefined, which is what makes that merge preserve what
 * was not sent. Empty `secret` means "leave the stored one alone".
 */
const patchMcpSchema = mcpFields.partial();

export default defineRoutes((ctx) => {
  const runtime = ctx.services.get('runtime');
  return [
    route({
      method: 'GET',
      path: '/api/model-providers',
      access: 'runtime:read',
      handler: () => ({ providers: runtime.list(), ready: runtime.ready() }),
    }),

    route({
      method: 'POST',
      path: '/api/model-providers',
      access: 'runtime:manage',
      body: createSchema,
      handler: ({ body }) => {
        if (body.kind === 'openai-compatible' && body.baseUrl === null) {
          throw badRequest('an OpenAI-compatible provider needs the endpoint it should call');
        }
        return created({ provider: runtime.create(body) });
      },
    }),

    route({
      method: 'PATCH',
      path: '/api/model-providers/:id',
      access: 'runtime:manage',
      body: patchSchema,
      handler: ({ params, body }) => {
        const provider = runtime.update(params.id, body);
        if (!provider) throw notFound('provider not found');
        return { provider };
      },
    }),

    route({
      method: 'DELETE',
      path: '/api/model-providers/:id',
      access: 'runtime:manage',
      handler: ({ params }) => {
        if (!runtime.get(params.id)) throw notFound('provider not found');
        runtime.delete(params.id);
        return { ok: true };
      },
    }),

    /**
     * What the endpoint says it serves. The answer is a suggestion: the
     * operator still ticks which of them this instance may spend on.
     */
    route({
      method: 'GET',
      path: '/api/model-providers/:id/available-models',
      access: 'runtime:manage',
      handler: async ({ params }) => {
        if (!runtime.get(params.id)) throw notFound('provider not found');
        return { models: await runtime.discover(params.id) };
      },
    }),

    /**
     * What a probe observed, rather than what the operator hoped. An endpoint
     * that advertises a model it cannot tool-call is common enough that being
     * told on the first real run is the wrong place to find out.
     */
    route({
      method: 'POST',
      path: '/api/model-providers/:id/probe',
      access: 'runtime:manage',
      body: z.object({ model: z.string().min(1).max(200) }),
      handler: async ({ params, body }) => {
        const provider = runtime.get(params.id);
        if (!provider) throw notFound('provider not found');
        const result = await runtime.probe(params.id, body.model);
        return { result };
      },
    }),

    // ---------- MCP servers -------------------------------------------------

    route({
      method: 'GET',
      path: '/api/mcp-servers',
      access: 'runtime:read',
      handler: () => ({ servers: runtime.listMcp() }),
    }),

    route({
      method: 'POST',
      path: '/api/mcp-servers',
      access: 'runtime:manage',
      body: createMcpSchema,
      handler: ({ body }) => created({ server: runtime.createMcp(body) }),
    }),

    route({
      method: 'PATCH',
      path: '/api/mcp-servers/:id',
      access: 'runtime:manage',
      body: patchMcpSchema,
      handler: ({ params, body }) => {
        const existing = runtime.getMcp(params.id);
        if (!existing) throw notFound('MCP server not found');
        // Checked against the MERGED record: a patch that only flips the
        // transport would otherwise store a stdio server with no command.
        const merged = { ...existing, ...body };
        if (merged.transport === 'stdio' && !(merged.command ?? '').length) {
          throw badRequest('a stdio server needs the command that starts it');
        }
        if (merged.transport === 'http' && merged.url === null) {
          throw badRequest('an http server needs the endpoint it is reached at');
        }
        const server = runtime.updateMcp(params.id, body);
        if (!server) throw notFound('MCP server not found');
        return { server };
      },
    }),

    route({
      method: 'DELETE',
      path: '/api/mcp-servers/:id',
      access: 'runtime:manage',
      handler: ({ params }) => {
        if (!runtime.getMcp(params.id)) throw notFound('MCP server not found');
        runtime.deleteMcp(params.id);
        return { ok: true };
      },
    }),

    /**
     * One real connection, so an operator learns that a server works and which
     * tools it offers here rather than from a run that quietly lost them.
     */
    route({
      method: 'POST',
      path: '/api/mcp-servers/:id/check',
      access: 'runtime:manage',
      handler: async ({ params }) => {
        if (!runtime.getMcp(params.id)) throw notFound('MCP server not found');
        return { result: await runtime.checkMcp(params.id) };
      },
    }),
  ];
});
