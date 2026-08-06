import { defineClientModule } from '@moxxy/companion-sdk/client';
import '../contract/index.js';
import manifest from '../module.js';
import { nav } from './nav.js';
import { routes } from './routes.js';

export { workbenchApi } from './api.js';
export { PreparedActions } from './components/PreparedActions.js';

export default defineClientModule({ manifest, nav, routes });
