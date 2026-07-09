import { defineApiModule } from '@companion/core/server';
import manifest from '../module.js';
import acl from './acl.js';
import migrations from './migrations.js';
import registerServices from './services.js';

/**
 * module-workspace's `/api` barrel. Provides the access-control store other
 * modules scope through. Routes (workspace CRUD/members/metrics), notifications,
 * and reports/overview are added in a follow-up carve.
 */
export default defineApiModule({
  manifest,
  acl,
  migrations,
  registerServices,
});
