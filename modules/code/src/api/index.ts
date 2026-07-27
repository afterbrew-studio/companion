import { defineApiModule } from '@moxxy-ai/companion-sdk/server';
import manifest from '../module.js';
import acl from './acl.js';
import migrations from './migrations.js';
import registerServices from './services.js';
import routes from './routes.js';
import lifecycle from './jobs.js';

/**
 * module-code's `/api` barrel — the GitHub-facing domain: repositories + the
 * multi-account registry, the issues/PRs sync cache (GitHub stays
 * authoritative), triage, AI reviews + CI checks, fixes (issue → PR), and
 * pipelines. Depends on operate (runs execute there), workspace (scoping) and
 * core (settings); plan and automations build on top of this bundle.
 */
export default defineApiModule({
  manifest,
  acl,
  migrations,
  registerServices,
  routes,
  lifecycle,
});
