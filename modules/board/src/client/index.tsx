import { defineClientModule } from '@moxxy/companion-sdk/client';
import '../contract/index.js';
import manifest from '../module.js';
import { actions, nav, sections } from './nav.js';
import { routes } from './routes.js';

export { boardApi } from './api.js';

export default defineClientModule({ manifest, sections, nav, routes, quickActions: actions });
