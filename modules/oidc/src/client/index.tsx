import { defineClientModule } from '@moxxy/companion-sdk/client';
import '../contract/index.js';
import manifest from '../module.js';

/**
 * Deliberately empty. The sign-in button is not a page or a slot: module-core's
 * login page renders one per registered provider, so this module contributes
 * nothing to the SPA beyond existing.
 */
export default defineClientModule({
  manifest,
});
