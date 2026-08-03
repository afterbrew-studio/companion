import { accepted, defineRoutes, forbidden, route } from '@moxxy/companion-sdk/server';
import type { AuthUser } from '@moxxy/companion-contracts';
import type {
  PlaygroundProductionEvaluationRun,
  PlaygroundProductionEvaluationSnapshot,
} from '../contract/index.js';

export { buildRolloutGate } from './production-evaluations.js';

/** HTTP boundary for the durable production prompt/parser release gate. */
export default defineRoutes((ctx) => {
  const production = ctx.services.get('playground').production;
  const requireAgentRun: (user: AuthUser | null) => asserts user is AuthUser = (user) => {
    if (!user || !ctx.rbac.has(user.role, 'runs:read') || !ctx.rbac.has(user.role, 'runs:act')) {
      throw forbidden('this action also requires runs:read and runs:act');
    }
  };
  return [
    route({
      method: 'GET',
      path: '/api/playground/production-evaluations',
      access: 'playground:run',
      handler: ({ user }): PlaygroundProductionEvaluationSnapshot => production.snapshot(user!),
    }),
    route({
      method: 'POST',
      path: '/api/playground/production-evaluations/:id/run',
      access: 'playground:run',
      handler: async ({ params, user }): Promise<{ evaluationRun: PlaygroundProductionEvaluationRun }> => {
        requireAgentRun(user);
        return { evaluationRun: await production.run(params.id, user) };
      },
    }),
    route({
      method: 'POST',
      path: '/api/playground/production-evaluations/:id/cancel',
      access: 'playground:run',
      handler: async ({ params, user }) => {
        requireAgentRun(user);
        await production.cancelCase(params.id, user);
        return { ok: true as const };
      },
    }),
    route({
      method: 'POST',
      path: '/api/playground/production-evaluations/run-all',
      access: 'playground:run',
      handler: ({ user }) => {
        requireAgentRun(user);
        return accepted({ evaluationSuite: production.startSuite(user) });
      },
    }),
    route({
      method: 'POST',
      path: '/api/playground/production-evaluations/suites/:id/cancel',
      access: 'playground:run',
      handler: async ({ params, user }) => {
        requireAgentRun(user);
        await production.cancelSuite(params.id, user);
        return { ok: true as const };
      },
    }),
  ];
});
