import { defineApiModule } from '@companion/core/server';
import manifest from '../module.js';
import acl from './acl.js';
import routes from './routes.js';

/**
 * module-playground's `/api` barrel — the agent test bench. Owns no tables and
 * registers no service (nothing consumes it cross-module): no migrations, no
 * services. Its routes resolve operate/workspace/code through the registry.
 */
export default defineApiModule({
  manifest,
  acl,
  routes,
});
