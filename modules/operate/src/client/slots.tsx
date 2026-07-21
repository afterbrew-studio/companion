import { defineSlots } from '@companion/core/client';
import { TokenBurnWidget } from './components/TokenBurn.js';

/**
 * Contributions rendered INTO other modules' pages. The dashboard (module-code)
 * exposes `dashboard.widgets`; operate drops its token-burn chart there so the
 * execution plane's spend is visible at a glance — without code importing
 * operate's client.
 */
export const slots = defineSlots([
  {
    slot: 'dashboard.widgets',
    key: 'operate-token-burn',
    order: 10,
    permission: 'runs:read',
    component: TokenBurnWidget,
  },
]);
