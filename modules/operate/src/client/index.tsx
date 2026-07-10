import { defineClientModule } from '@companion/core/client';
import manifest from '../module.js';
import { nav, sections } from './nav.js';
import { routes } from './routes.js';

/**
 * The `/client` barrel — module-operate's web surface: agent runs + the run
 * queue, runner machines, providers, and skills. Vite reads this as source.
 */

// The shell and downstream modules (code/plan/automations) reach these by
// name — everything else is routed.
export { RunQueueIndicator } from './components/RunQueue.js';
export { AgentActivity } from './components/AgentActivity.js';
export { AskSheet } from './components/AskSheet.js';
export { Transcript } from './transcript/Transcript.js';
export { emptyFold, foldEvent, foldMany } from './transcript/fold.js';
export type { Block, FoldState } from './transcript/fold.js';
export { useRun } from './hooks/useRun.js';
export type { UseRun } from './hooks/useRun.js';
export { useRuns } from './hooks/useRuns.js';
export { useRunQueue } from './hooks/useRunQueue.js';
export { useAiActivity } from './hooks/useAiActivity.js';
export type { AiActivity } from './hooks/useAiActivity.js';
export { useMoxxyStatus } from './hooks/useMoxxyStatus.js';
export { operateApi } from './api.js';

export default defineClientModule({
  manifest,
  sections,
  nav,
  routes,
});
