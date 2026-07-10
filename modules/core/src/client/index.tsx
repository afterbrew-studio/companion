import { defineClientModule } from '@companion/core/client';
// Carries this module's contract augmentations (Permission/ServiceMap/messages)
// into every compilation that loads the client slice.
import '../contract/index.js';
import manifest from '../module.js';
import { nav, sections } from './nav.js';
import { routes } from './routes.js';

/**
 * The `/client` barrel — module-core's web surface: the auth provider and the
 * pre-login pages the shell mounts directly, plus the Users/Profile/Modules
 * routes and the Admin sidebar group. Vite reads this as source.
 */

// The shell (and other modules) reach these by name — everything else is routed.
export { AuthProvider, useAuth } from './lib/auth.js';
export { LoginPage } from './pages/Login.js';
export { SetupPage } from './pages/Setup.js';
export { Onboarding, hasOnboarded, hasUnseenOnboarding } from './components/Onboarding.js';
export type { OnboardingMode } from './components/Onboarding.js';
export { authApi, coreApi, modulesApi } from './api.js';

export default defineClientModule({
  manifest,
  sections,
  nav,
  routes,
});
