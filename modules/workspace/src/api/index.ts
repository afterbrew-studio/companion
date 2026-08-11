import { defineApiModule } from '@moxxy/companion-sdk/server';
import manifest from '../module.js';
import acl from './acl.js';
import migrations from './migrations.js';
import registerServices from './services.js';
import routes from './routes.js';
import lifecycle from './jobs.js';

/**
 * module-workspace's `/api` barrel. Provides the access-control store other
 * modules scope through, the notification inbox emitter/reader, and the
 * workspace CRUD/members/metrics + inbox routes. The cross-domain per-workspace
 * feeds stay with their owning modules (code/plan).
 */
export default defineApiModule({
  manifest,
  acl,
  migrations,
  registerServices,
  routes,
  lifecycle,
});
