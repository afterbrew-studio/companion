import { defineClientModule } from '@moxxy/companion-sdk/client';
// Carries this module's contract augmentations (Permission/ServiceMap/messages)
// into every compilation that loads the client slice.
import '../contract/index.js';
import manifest from '../module.js';
import { nav } from './nav.js';
import { routes } from './routes.js';

/**
 * The `/client` barrel: one Admin entry, one page with the channel list, the add
 * form and the recent delivery log.
 */

export { notifyApi } from './api.js';
export { useChannels } from './hooks/useChannels.js';

export default defineClientModule({ manifest, nav, routes });
