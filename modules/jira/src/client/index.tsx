import '../contract/index.js';
import { defineClientModule } from '@moxxy/companion-sdk/client';
import manifest from '../module.js';
import { slots } from './slots.js';

export { jiraApi } from './api.js';

export default defineClientModule({ manifest, slots });
