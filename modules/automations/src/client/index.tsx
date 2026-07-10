import { defineClientModule } from '@companion/core/client';
// Carries this module's contract augmentations (Permission/ServiceMap/messages)
// into every compilation that loads the client slice.
import '../contract/index.js';
import manifest from '../module.js';
import { nav } from './nav.js';
import { routes } from './routes.js';

/**
 * The `/client` barrel — module-automations' web surface: the Automations
 * route under the Operate sidebar section, plus AI Help (the assistant button
 * + docked panel the shell mounts by name). Vite reads this as source.
 */

// The shell reaches these by name — everything else is routed.
export { AssistantButton, AssistantPanel } from './components/Assistant.js';
export { automationsApi } from './api.js';

export default defineClientModule({
  manifest,
  nav,
  routes,
});
