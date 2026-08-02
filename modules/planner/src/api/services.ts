import { defineServices } from '@moxxy/companion-sdk/server';
import { PlannerService } from './planner-service.js';
import { PlannerStore } from './planner-store.js';
import {
  buildPlannerClarificationEvaluationPrompt,
  parseClarification,
  PLANNER_CLARIFICATION_PROMPT_VERSION,
} from './prompts.js';

export default defineServices((ctx) => {
  const operate = ctx.services.get('operate');
  operate.registerRunTask({
    id: 'planner.analyses',
    label: 'Ideas planning',
    placeable: false,
    hint: 'clarification, planning artifacts and revisions',
  });
  operate.promptEvaluations.register({
    id: 'planner.clarification',
    moduleId: 'planner',
    label: 'Idea clarification',
    task: 'planner.analyses',
    version: PLANNER_CLARIFICATION_PROMPT_VERSION,
    buildPrompt: buildPlannerClarificationEvaluationPrompt,
    parseResponse: parseClarification,
  });
  ctx.services.register('planner', new PlannerService(
    new PlannerStore(ctx.db),
    ctx.services.get('plan'),
    ctx.services.get('refinement'),
    ctx.services.get('board'),
    ctx.services.get('code'),
    operate,
    ctx.notify,
    ctx.broadcast,
  ));
});
