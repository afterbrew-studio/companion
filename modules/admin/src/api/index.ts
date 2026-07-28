import { defineApiModule } from '@moxxy/companion-core/server';
import manifest from '../module.js';
import routes from './routes.js';

/**
 * module-admin's `/api` barrel — the instance-administration surface over
 * core-owned settings. Owns no tables and grants no new capabilities: no
 * migrations, no acl, no services. Its routes read/write settings via
 * `ctx.settings`, gated by `settings:manage` (owned by module-core).
 */
export default defineApiModule({
  manifest,
  routes,
});
