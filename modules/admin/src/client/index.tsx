import { defineClientModule } from '@moxxy/companion-core/client';
// Carries this module's contract augmentations (Permission/ServiceMap/messages)
// into every compilation that loads the client slice.
import '../contract/index.js';
import manifest from '../module.js';
import { nav } from './nav.js';
import { routes } from './routes.js';

/**
 * The `/client` barrel — module-admin's web surface: the instance Settings
 * page, slotted into core's Admin sidebar group. Vite reads this as source.
 */

export { adminApi } from './api.js';

export default defineClientModule({
  manifest,
  nav,
  routes,
});
