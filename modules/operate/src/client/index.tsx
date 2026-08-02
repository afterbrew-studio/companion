import { defineClientModule } from '@moxxy/companion-core/client';
// Carries this module's contract augmentations (Permission/ServiceMap/messages)
// into every compilation that loads the client slice.
import '../contract/index.js';
import manifest from '../module.js';
import { nav, sections } from './nav.js';
import { routes } from './routes.js';
import { slots } from './slots.js';
import { onboarding } from './onboarding.js';

/**
 * The `/client` barrel — module-operate's web surface: agent runs + the run
 * queue, runner machines, providers, and skills. Vite reads this as source.
 */

// The shell and downstream modules (code/plan/automations) reach these by
// name — everything else is routed.
export { RunQueueIndicator, RunnerCapacityBanner } from './components/RunQueue.js';
export { TokenBurnWidget } from './components/TokenBurn.js';
export { AgentActivity } from './components/AgentActivity.js';
export { AskSheet } from './components/AskSheet.js';
export { LanePicker } from './components/LanePicker.js';
export { useLane, type UseLane } from './hooks/useLane.js';
export { LaneNote } from './components/LaneNote.js';
export { Transcript } from './transcript/Transcript.js';
export { emptyFold, foldEvent, foldMany } from './transcript/fold.js';
export type { Block, FoldState } from './transcript/fold.js';
export { useRun } from './hooks/useRun.js';
export type { UseRun } from './hooks/useRun.js';
export { useRuns, useRunsPage } from './hooks/useRuns.js';
export { useRunQueue } from './hooks/useRunQueue.js';
export { useRunnerCapacity } from './hooks/useRunnerCapacity.js';
export { useAiActivity } from './hooks/useAiActivity.js';
export type { AiActivity } from './hooks/useAiActivity.js';
export { useMoxxyStatus } from './hooks/useMoxxyStatus.js';
export { operateApi } from './api.js';

export default defineClientModule({
  manifest,
  sections,
  nav,
  routes,
  slots,
  onboarding,
});
