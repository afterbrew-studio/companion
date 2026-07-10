import { defineApiModule } from '@companion/core/server';
import manifest from '../module.js';
import acl from './acl.js';
import registerServices from './services.js';
import routes from './routes.js';
import rawRoutes from './raw-routes.js';
import lifecycle from './jobs.js';

/**
 * module-automations' `/api` barrel — the reactor: GitHub webhooks + the
 * schedule ticker driving code/plan/operate, and AI Help. No migrations: this
 * module owns no tables — briefing cadences and webhook secrets live in
 * core-owned settings and code-owned repos columns.
 */
export default defineApiModule({
  manifest,
  acl,
  registerServices,
  routes,
  rawRoutes,
  lifecycle,
});
