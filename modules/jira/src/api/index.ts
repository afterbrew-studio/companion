import { defineApiModule } from '@moxxy/companion-sdk/server';
import manifest from '../module.js';
import acl from './acl.js';
import lifecycle from './jobs.js';
import migrations from './migrations.js';
import routes from './routes.js';
import registerServices from './services.js';

export default defineApiModule({ manifest, acl, migrations, registerServices, routes, lifecycle });
