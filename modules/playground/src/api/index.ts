import { defineApiModule } from '@moxxy/companion-sdk/server';
import manifest from '../module.js';
import acl from './acl.js';
import registerServices from './services.js';
import routes from './routes.js';

/**
 * module-playground's `/api` barrel — the agent test bench. Owns no tables and
 * publishes no service bundle (nothing consumes it cross-module); services.ts
 * only registers its run-task descriptor with operate. Its routes resolve
 * operate/workspace/code through the registry.
 */
export default defineApiModule({
  manifest,
  acl,
  registerServices,
  routes,
});
