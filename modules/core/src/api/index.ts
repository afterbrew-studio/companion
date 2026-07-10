import { defineApiModule } from '@companion/core/server';
import manifest from '../module.js';
import acl from './acl.js';
import migrations from './migrations.js';
import registerServices from './services.js';
import routes from './routes.js';

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
  provideAuthenticator: (ctx) => ctx.services.get('core'),
});
