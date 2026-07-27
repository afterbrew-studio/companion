import { defineApiModule } from '@companion/core/server';
import manifest from '../module.js';
import acl from './acl.js';
import migrations from './migrations.js';
import registerServices from './services.js';
import routes from './routes.js';
import lifecycle from './jobs.js';

/**
 * module-core's `/api` barrel. `provideAuthenticator` hands the kernel the Auth
 * instance (required module, activates first) that the dynamic router uses to
 * verify tokens + enforce capabilities on every request.
 */
export default defineApiModule({
  manifest,
  acl,
  migrations,
  registerServices,
  routes,
  lifecycle,
  provideAuthenticator: (ctx) => ctx.services.get('core'),
  // module-core owns `audit_log`, so it provides the sink the router writes
  // through. A dedicated audit module sorts after core and would take over.
  provideAudit: (ctx) => ctx.services.get('audit'),
});
