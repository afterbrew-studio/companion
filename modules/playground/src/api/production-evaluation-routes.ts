import { accepted, defineRoutes, route } from '@moxxy/companion-sdk/server';
import type {
  PlaygroundProductionEvaluationRun,
  PlaygroundProductionEvaluationSnapshot,
} from '../contract/index.js';

export { buildRolloutGate } from './production-evaluations.js';

/** HTTP boundary for the durable production prompt/parser release gate. */
export default defineRoutes((ctx) => {
  const production = ctx.services.get('playground').production;
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
      handler: async ({ params, user }): Promise<{ evaluationRun: PlaygroundProductionEvaluationRun }> => ({
        evaluationRun: await production.run(params.id, user!),
      }),
    }),
    route({
      method: 'POST',
      path: '/api/playground/production-evaluations/:id/cancel',
      access: 'playground:run',
      handler: async ({ params, user }) => {
        await production.cancelCase(params.id, user!);
        return { ok: true as const };
      },
    }),
    route({
      method: 'POST',
      path: '/api/playground/production-evaluations/run-all',
      access: 'playground:run',
      handler: ({ user }) => accepted({ evaluationSuite: production.startSuite(user!) }),
    }),
    route({
      method: 'POST',
      path: '/api/playground/production-evaluations/suites/:id/cancel',
      access: 'playground:run',
      handler: async ({ params, user }) => {
        await production.cancelSuite(params.id, user!);
        return { ok: true as const };
      },
    }),
  ];
});
