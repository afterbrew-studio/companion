import { defineServices } from '@moxxy/companion-sdk/server';
import { WorkbenchActions } from './workbench-actions.js';
import { WorkbenchActionsStore } from './workbench-actions-store.js';
import { WorkbenchService } from './workbench-service.js';

/** Publish the read-only composition seam for HTTP today and agent tools later. */
export default defineServices((ctx) => {
  const workspace = ctx.services.get('workspace');
  const operate = ctx.services.get('operate');
  const code = ctx.services.get('code');
  const board = () => ctx.services.tryGet('board');
  const plan = () => ctx.services.tryGet('plan');
  const actions = new WorkbenchActions(
    new WorkbenchActionsStore(ctx.db),
    workspace,
    operate,
    code,
    board,
    plan,
    (username) => ctx.pushToUser(username, { t: 'workbench.actions.changed' }),
    (event) => ctx.audit.record(event),
  );

  ctx.services.register(
    'workbench',
    new WorkbenchService(
      actions,
      workspace,
      operate,
      code,
      board,
      (user) => ({
        board: ctx.rbac.allows(user, 'board:read') && ctx.rbac.allows(user, 'board:manage'),
        runs: ctx.rbac.allows(user, 'runs:read') && ctx.rbac.allows(user, 'runs:act'),
        prs: ctx.rbac.allows(user, 'prs:read') && ctx.rbac.allows(user, 'prs:act'),
        issues: ctx.rbac.allows(user, 'issues:read') && ctx.rbac.allows(user, 'issues:act'),
      }),
    ),
  );
});
