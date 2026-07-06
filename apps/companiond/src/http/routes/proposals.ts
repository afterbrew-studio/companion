import { z } from 'zod';
import { route, accepted, created, badRequest, type CompiledRoute } from '../router.js';
import { log } from '../../log.js';
import type { ApiDeps } from '../deps.js';

const proposalSchema = z.object({
  repo: z.string(),
  title: z.string().min(3).max(200),
  body: z.string().min(1),
});

export function proposalRoutes(deps: ApiDeps): CompiledRoute[] {
  return [
    route({
      method: 'GET',
      path: '/api/proposals',
      access: 'proposals:read',
      handler: () => ({ proposals: deps.store.listProposals() }),
    }),

    route({
      method: 'POST',
      path: '/api/proposals',
      access: 'proposals:create',
      body: proposalSchema,
      handler: ({ body }) => {
        if (!deps.store.getRepo(body.repo)) throw badRequest(`repo ${body.repo} not connected`);
        return created({ proposal: deps.proposals.create(body.repo, body.title, body.body) });
      },
    }),

    // Analysis is read-only and part of filing a proposal, so it rides
    // proposals:create — business users see feasibility before a maintainer
    // ever gets involved.
    route({
      method: 'POST',
      path: '/api/proposals/:id/analyze',
      access: 'proposals:create',
      handler: ({ params }) => {
        void deps.proposals
          .analyze(params.id)
          .catch((err) => log.warn('analysis failed', { id: params.id, err: String(err) }));
        return accepted({ queued: true });
      },
    }),

    route({
      method: 'POST',
      path: '/api/proposals/:id/approve',
      access: 'proposals:act',
      handler: async ({ params }) => ({ proposal: await deps.proposals.approve(params.id) }),
    }),

    route({
      method: 'POST',
      path: '/api/proposals/:id/finish',
      access: 'proposals:act',
      handler: async ({ params }) => ({ proposal: await deps.proposals.finishImplementation(params.id) }),
    }),

    route({
      method: 'POST',
      path: '/api/proposals/:id/reject',
      access: 'proposals:act',
      handler: ({ params }) => {
        deps.proposals.reject(params.id);
        return { ok: true };
      },
    }),
  ];
}
