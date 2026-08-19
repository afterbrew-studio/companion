import { defineApiModule } from '@moxxy/companion-sdk/server';
import manifest from '../module.js';
import migrations from './migrations.js';
import registerServices from './services.js';
import routes from './routes.js';
import lifecycle from './jobs.js';

export default defineApiModule({ manifest, migrations, registerServices, routes, lifecycle });
