import { defineServices } from '@moxxy/companion-sdk/server';
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
  const core = ctx.services.get('core');
  const workspace = ctx.services.get('workspace');
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
      workspace,
      () => ctx.services.tryGet('plan'),
      (username, permission, repo) => {
        const role = core.activeUserRole(username);
        return role !== undefined &&
          ctx.rbac.has(role, permission) &&
          (!repo || workspace.canAccessRepo({ username, displayName: username, role }, repo));
      },
      ctx.broadcast,
      ctx.notify,
    ),
  );
});
