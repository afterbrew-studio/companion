import { defineApiModule } from '@moxxy/companion-core/server';
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

/** A caller's zod answer shape, as the wire format a harness can enforce. */
export { resultSchemaOf } from './result-schema.js';

/**
 * The harness registry, which is how a module contributes an agent runtime
 * without this module knowing its name. Registration belongs to the enabling
 * module's lifecycle, so it also has to be undone on disable.
 */
export {
  registerHarness,
  unregisterHarness,
  type HarnessRegistration,
  type HarnessSpawnRequest,
} from './harnesses.js';
