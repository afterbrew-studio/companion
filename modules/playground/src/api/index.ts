import { defineApiModule } from '@moxxy/companion-sdk/server';
import manifest from '../module.js';
import acl from './acl.js';
import migrations from './migrations.js';
import registerServices from './services.js';
import routes from './routes.js';
import lifecycle from './jobs.js';

/**
 * module-playground's `/api` barrel — the agent test bench. Its migrations own
 * the saved evaluation corpus, bounded comparison history and durable
 * production release-gate state. Routes and lifecycle hooks share one
 * module-owned service through the registry.
 */
export default defineApiModule({
  manifest,
  acl,
  migrations,
  registerServices,
  routes,
  lifecycle,
});
