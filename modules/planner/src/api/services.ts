import { defineServices } from '@companion/core/server';
import { PlannerService } from './planner-service.js';
import { PlannerStore } from './planner-store.js';

export default defineServices((ctx) => {
  const operate = ctx.services.get('operate');
  operate.registerRunTask({
    id: 'planner.analyses',
    label: 'Ideas planning',
    placeable: false,
    hint: 'clarification, planning artifacts and revisions',
  });
  ctx.services.register('planner', new PlannerService(
    new PlannerStore(ctx.db),
    ctx.services.get('plan'),
    ctx.services.get('refinement'),
    ctx.services.get('board'),
    ctx.services.get('code'),
    operate,
    ctx.broadcast,
  ));
});
