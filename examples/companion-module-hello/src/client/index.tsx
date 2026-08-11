import { defineClientModule } from '@moxxy/companion-sdk/client';
// Carries this module's contract augmentations (the permission) into every
// compilation that loads the client slice.
import '../contract/index.js';
import manifest from '../module.js';
import { nav, sections } from './nav.js';
import { routes } from './routes.js';

export default defineClientModule({ manifest, sections, nav, routes });
