import { defineApiModule } from '@moxxy/companion-sdk/server';
import manifest from '../module.js';
import acl from './acl.js';
import migrations from './migrations.js';
import registerServices from './services.js';
import routes from './routes.js';
import lifecycle from './jobs.js';

/**
 * module-runtime's `/api` barrel: the provider registry plus the harness
 * registration that makes Companion's own agent loop a runtime this instance
 * can place work on.
 */
export default defineApiModule({ manifest, acl, migrations, registerServices, routes, lifecycle });
