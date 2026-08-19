import { defineJobs } from '@moxxy/companion-sdk/server';

let offWorkspaceDeleted: (() => void) | null = null;

export default defineJobs({
  onEnable: (ctx) => {
    offWorkspaceDeleted?.();
    offWorkspaceDeleted = ctx.bus.on('workspace.deleted', ({ workspaceId }) => {
      ctx.services.get('desk').removeForWorkspace(workspaceId);
    });
  },
  onDisable: () => {
    offWorkspaceDeleted?.();
    offWorkspaceDeleted = null;
  },
});
