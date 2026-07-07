import { savePipelineSchema, saveStepDefinitionSchema } from '../../pipelines/pipelines.js';
import { route, notFound, type CompiledRoute } from '../router.js';
import type { ApiDeps } from '../deps.js';

/** Pipeline + step-definition mutation by id, and pipeline-run lookups. */
export function pipelineRoutes(deps: ApiDeps): CompiledRoute[] {
  return [
    route({
      method: 'PUT',
      path: '/api/pipelines/:id',
      access: 'pipelines:manage',
      body: savePipelineSchema,
      handler: ({ params, body }) => ({ pipeline: deps.pipelines.update(params.id, body) }),
    }),

    route({
      method: 'DELETE',
      path: '/api/pipelines/:id',
      access: 'pipelines:manage',
      handler: ({ params }) => {
        deps.pipelines.remove(params.id);
        return { ok: true };
      },
    }),

    route({
      method: 'PUT',
      path: '/api/step-definitions/:id',
      access: 'pipelines:manage',
      body: saveStepDefinitionSchema,
      handler: ({ params, body }) => ({
        stepDefinition: deps.pipelines.updateStepDefinition(params.id, body),
      }),
    }),

    route({
      method: 'DELETE',
      path: '/api/step-definitions/:id',
      access: 'pipelines:manage',
      handler: ({ params }) => {
        deps.pipelines.removeStepDefinition(params.id);
        return { ok: true };
      },
    }),

    route({
      method: 'GET',
      path: '/api/pipeline-runs/:id',
      access: 'pipelines:read',
      handler: ({ params }) => {
        const run = deps.store.pipelines.getRun(params.id);
        if (!run) throw notFound(`pipeline run ${params.id} not found`);
        return { run };
      },
    }),
  ];
}
