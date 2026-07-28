import { defineClientModule } from '@moxxy/companion-sdk/client';
// Carries this module's contract augmentations (Permission registry) into
// every compilation that loads the client slice.
import '../contract/index.js';
import manifest from '../module.js';
import { nav, sections } from './nav.js';
import { routes } from './routes.js';
import { slots } from './slots.js';

/**
 * The `/client` barrel — module-playground's web surface: the Agent Lab
 * (fenced one-shot test runs, skill dry-runs) and the Pipeline Lab
 * (zero-side-effect pipeline previews). Vite reads this as source.
 */

export { playgroundApi } from './api.js';

export default defineClientModule({
  manifest,
  sections,
  nav,
  routes,
  slots,
});
