import { defineJobs } from '@moxxy/companion-sdk/server';

let offWorkspaceDeleted: (() => void) | null = null;
let offRunChanged: (() => void) | null = null;
let offRunAsk: (() => void) | null = null;
let offRunAskResolved: (() => void) | null = null;
let offPrStatusChanged: (() => void) | null = null;
let offActionChanged: (() => void) | null = null;

export default defineJobs({
  onEnable: (ctx) => {
    const desk = ctx.services.get('desk');
    offWorkspaceDeleted?.();
    offWorkspaceDeleted = ctx.bus.on('workspace.deleted', ({ workspaceId }) => {
      desk.removeForWorkspace(workspaceId);
    });
    offRunChanged?.();
    offRunChanged = ctx.bus.on('run.changed', (run) => desk.recordRun(run));
    offRunAsk?.();
    offRunAsk = ctx.bus.on('run.ask', ({ runId, ask }) => desk.recordAsk(runId, ask));
    offRunAskResolved?.();
    offRunAskResolved = ctx.bus.on('run.askResolved', ({ runId, requestId }) => desk.recordAskResolved(runId, requestId));
    offPrStatusChanged?.();
    offPrStatusChanged = ctx.bus.on('code.pr-status.changed', ({ repo, number, status }) =>
      desk.recordPrStatus(repo, number, status),
    );
    offActionChanged?.();
    offActionChanged = ctx.bus.on('workbench.action.changed', (action) => desk.recordAction(action));
  },
  onDisable: () => {
    offWorkspaceDeleted?.();
    offWorkspaceDeleted = null;
    offRunChanged?.();
    offRunChanged = null;
    offRunAsk?.();
    offRunAsk = null;
    offRunAskResolved?.();
    offRunAskResolved = null;
    offPrStatusChanged?.();
    offPrStatusChanged = null;
    offActionChanged?.();
    offActionChanged = null;
  },
});
