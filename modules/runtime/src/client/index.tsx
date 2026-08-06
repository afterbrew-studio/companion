import { defineClientModule } from '@moxxy/companion-sdk/client';
// Carries this module's contract augmentations (Permission/ServiceMap/messages)
// into every compilation that loads the client slice.
import '../contract/index.js';
import manifest from '../module.js';
import { nav } from './nav.js';
import { routes } from './routes.js';

export { mcpApi, runtimeApi } from './api.js';
export { useProviders } from './hooks/useProviders.js';
export { useMcpServers } from './hooks/useMcpServers.js';

export default defineClientModule({ manifest, nav, routes });
