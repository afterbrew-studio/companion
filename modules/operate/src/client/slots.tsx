import { defineSlots } from '@moxxy/companion-core/client';
import { TokenBurnWidget } from './components/TokenBurn.js';
import { BudgetBar } from './components/BudgetBar.js';
import { AgentsStatus } from './components/AgentsStatus.js';
import { CeilingReach } from './components/CeilingReach.js';
import { RunnerCapacityBanner, RunQueueIndicator } from './components/RunQueue.js';

/**
 * Contributions rendered INTO other modules' pages and into the app shell. The
 * dashboard (module-code) exposes `dashboard.widgets`; the shell exposes
 * `shell.banner` and `shell.topbar`; module-core exposes
 * `modules.config.<moduleId>` above a module's own settings form. Attaching
 * here is what lets a build without operate drop all of this without the shell
 * knowing operate exists.
 */
export const slots = defineSlots([
  {
    slot: 'modules.config.operate',
    key: 'operate-ceiling-reach',
    order: 0,
    permission: 'runners:connect',
    component: CeilingReach,
  },
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
    key: 'operate-budget',
    order: 5,
    permission: 'runs:read',
    component: BudgetBar,
  },
  {
    slot: 'dashboard.widgets',
    key: 'operate-token-burn',
    order: 10,
    permission: 'runs:read',
    component: TokenBurnWidget,
  },
]);
