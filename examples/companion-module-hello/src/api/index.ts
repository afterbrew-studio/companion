import { defineApiModule } from '@moxxy/companion-sdk/server';
import manifest from '../module.js';
import acl from './acl.js';
import migrations from './migrations.js';
import routes from './routes.js';

export default defineApiModule({ manifest, acl, migrations, routes });
