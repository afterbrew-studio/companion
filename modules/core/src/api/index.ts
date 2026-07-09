import { defineApiModule } from '@companion/core/server';
import manifest from '../module.js';
import acl from './acl.js';

/**
 * The `/api` barrel — module-core's server surface. Migrations, services
 * (Auth/Users/Settings/Notifications), routes and the authenticator land here as
 * the daemon is decomposed; for now it establishes the module shape + ACL.
 */
export default defineApiModule({
  manifest,
  acl,
});
