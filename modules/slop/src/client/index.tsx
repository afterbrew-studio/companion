import { defineClientModule } from '@moxxy/companion-sdk/client';
// Carries this module's contract augmentations (Permission/ServiceMap/messages)
// into every compilation that loads the client slice.
import '../contract/index.js';
import manifest from '../module.js';
import { nav } from './nav.js';
import { routes } from './routes.js';
import { slots } from './slots.js';

/**
 * The `/client` barrel, module-slop's web surface: one Slop Detection entry
 * in the Code sidebar group, the detections + rules pages, and the radar
 * widget rendered into code's dashboard slot.
 */

export { slopApi } from './api.js';
export { useSlopDetections } from './hooks/useSlopDetections.js';
export { useSlopRules } from './hooks/useSlopRules.js';

export default defineClientModule({ manifest, nav, routes, slots });
