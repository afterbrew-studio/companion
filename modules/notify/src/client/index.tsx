import { defineClientModule } from '@moxxy/companion-sdk/client';
// Carries this module's contract augmentations (Permission/ServiceMap/messages)
// into every compilation that loads the client slice.
import '../contract/index.js';
import manifest from '../module.js';
import { nav } from './nav.js';
import { routes } from './routes.js';
import { slots } from './slots.js';

/**
 * The `/client` barrel: delivery history is linked from the Integrations pane.
 */

export { notifyApi } from './api.js';

export default defineClientModule({ manifest, nav, routes, slots });
