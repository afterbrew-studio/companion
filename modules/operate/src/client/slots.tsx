import { defineSlots } from '@companion/core/client';
import { TokenBurnWidget } from './components/TokenBurn.js';
import { AgentsStatus } from './components/AgentsStatus.js';
import { RunnerCapacityBanner, RunQueueIndicator } from './components/RunQueue.js';

/**
 * Contributions rendered INTO other modules' pages and into the app shell. The
 * dashboard (module-code) exposes `dashboard.widgets`; the shell exposes
 * `shell.banner` and `shell.topbar`. Attaching here is what lets a build without
 * operate drop all of this without the shell knowing operate exists.
 */
export const slots = defineSlots([
  {
    slot: 'shell.banner',
    key: 'operate-runner-capacity',
    order: 0,
    permission: 'runs:read',
    component: RunnerCapacityBanner,
  },
  {
    slot: 'shell.topbar',
    key: 'operate-run-queue',
    order: 10,
    permission: 'runs:read',
    component: RunQueueIndicator,
  },
  {
    slot: 'shell.topbar',
    key: 'operate-agents-status',
    order: 30,
    permission: 'runs:read',
    component: AgentsStatus,
  },
  {
    slot: 'dashboard.widgets',
    key: 'operate-token-burn',
    order: 10,
    permission: 'runs:read',
    component: TokenBurnWidget,
  },
]);
