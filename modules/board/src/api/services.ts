import { defineServices } from '@moxxy-ai/companion-sdk/server';
import { BoardStore } from './board-store.js';
import { BoardService } from './board-service.js';

/**
 * Construct the board domain: the store over the board_* tables and the engine
 * that dispatches tasks to workers and walks the build → PR → review → merge
 * cycle. plan is a SOFT dependency (spec attachment) — resolved lazily so the
 * board runs with planning disabled.
 */
export default defineServices((ctx) => {
  const store = new BoardStore(ctx.db);
  const operate = ctx.services.get('operate');
  operate.registerRunTask({
    id: 'board.worker',
    label: 'Board workers',
    placeable: true,
    hint: 'autonomous task-board agents — the heaviest, longest-running work',
  });
  ctx.services.register(
    'board',
    new BoardService(
      store,
      ctx.services.get('code'),
      operate,
      ctx.services.get('workspace'),
      () => ctx.services.tryGet('plan'),
      ctx.broadcast,
      ctx.notify,
    ),
  );
});
