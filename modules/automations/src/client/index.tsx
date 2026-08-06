import { defineClientModule } from '@moxxy/companion-sdk/client';
// Carries this module's contract augmentations (Permission/ServiceMap/messages)
// into every compilation that loads the client slice.
import '../contract/index.js';
import manifest from '../module.js';
import { actions, nav } from './nav.js';
import { routes } from './routes.js';
import { slots } from './slots.js';

/**
 * The `/client` barrel — module-automations' web surface: repository-owned
 * settings contributed into Code, workspace health routes, and AI Help in the
 * shell top bar. Vite reads this as source.
 */

export { automationsApi } from './api.js';

export default defineClientModule({
  manifest,
  nav,
  routes,
  slots,
  quickActions: actions,
});
