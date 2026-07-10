import { defineApiModule } from '@companion/core/server';
import manifest from '../module.js';
import acl from './acl.js';
import migrations from './migrations.js';
import registerServices from './services.js';
import routes from './routes.js';
import lifecycle from './jobs.js';

/**
 * module-operate's `/api` barrel — the execution plane: the orchestrator + run
 * queue, the runner registry (local/remote machines), moxxy status/provider
 * settings, the public webhook tunnel and the skill library. The pure execution
 * primitives it drives live under `/exec` (bundled by companion-runner too).
 */
export default defineApiModule({
  manifest,
  acl,
  migrations,
  registerServices,
  routes,
  lifecycle,
});
