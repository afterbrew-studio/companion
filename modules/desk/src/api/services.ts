import { defineServices } from '@moxxy/companion-sdk/server';
import { DeskService } from './desk-service.js';
import { MissionsStore } from './missions-store.js';

export default defineServices((ctx) => {
  const operate = ctx.services.get('operate');
  operate.registerRunTask({ id: 'desk.mission', label: 'Desk missions', placeable: true });
  ctx.services.register(
    'desk',
    new DeskService(
      new MissionsStore(ctx.db),
      ctx.services.get('automations').assistant,
      ctx.services.get('workspace'),
      ctx.services.get('code'),
      ctx.broadcast,
    ),
  );
});
