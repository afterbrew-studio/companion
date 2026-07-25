import { defineClientModule } from '@companion/core/client';
import '../contract/index.js';
import manifest from '../module.js';
import { nav } from './nav.js';
import { routes } from './routes.js';
import { onboarding } from './onboarding.js';

export { ideasApi } from './api.js';
export { useIdeas } from './hooks/useIdeas.js';

export default defineClientModule({ manifest, nav, routes, onboarding });
