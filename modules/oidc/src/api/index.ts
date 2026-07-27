import { defineApiModule } from '@moxxy-ai/companion-sdk/server';
import manifest from '../module.js';
import routes from './routes.js';
import lifecycle from './jobs.js';

/**
 * module-oidc's `/api` barrel. It owns no tables and declares no permissions:
 * the two routes it serves are `public` because they run before a session
 * exists, and everything after the handshake is module-core's.
 */
export default defineApiModule({
  manifest,
  routes,
  lifecycle,
});
