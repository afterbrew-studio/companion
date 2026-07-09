import { defineApiModule } from '@companion/core/server';
import manifest from '../module.js';
import acl from './acl.js';
import migrations from './migrations.js';
import registerServices from './services.js';
import routes from './routes.js';
import lifecycle from './jobs.js';

/**
 * module-plan's `/api` barrel — the planning/grounding domain: proposals
 * (idea → analyzed → implemented PR, riding code's fix machinery),
 * specifications (living behavior docs with drift detection) and documentation
 * (workspace knowledge, chunk-indexed for retrieval). Depends on code (repos +
 * fixes + GitHub clients), operate (runs execute there), workspace (scoping)
 * and core (settings).
 */
export default defineApiModule({
  manifest,
  acl,
  migrations,
  registerServices,
  routes,
  lifecycle,
});
