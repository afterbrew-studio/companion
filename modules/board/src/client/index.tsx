import { defineClientModule } from '@moxxy-ai/companion-sdk/client';
import '../contract/index.js';
import manifest from '../module.js';
import { nav, sections } from './nav.js';
import { routes } from './routes.js';

export { boardApi } from './api.js';

export default defineClientModule({ manifest, sections, nav, routes });
