import { defineApiModule } from '@moxxy/companion-sdk/server';
import manifest from '../module.js';
import acl from './acl.js';
import migrations from './migrations.js';
import registerServices from './services.js';
import routes from './routes.js';
import rawRoutes from './raw-routes.js';
import lifecycle from './jobs.js';

/**
 * module-automations' `/api` barrel — the reactor: GitHub webhooks + the
 * schedule ticker driving code/plan/operate, and AI Help. Its only table is the
 * bounded GitHub delivery ledger used to make webhook retries idempotent.
 */
export default defineApiModule({
  manifest,
  acl,
  migrations,
  registerServices,
  routes,
  rawRoutes,
  lifecycle,
});
