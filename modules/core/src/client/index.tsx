import { defineClientModule } from '@companion/core/client';
import manifest from '../module.js';

/**
 * The `/client` barrel — module-core's web surface (Login/Setup/Profile/Inbox +
 * the Modules admin page land here). Vite reads this as source.
 */
export default defineClientModule({
  manifest,
});
