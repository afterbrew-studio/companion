import { defineApiModule } from '@moxxy/companion-sdk/server';
import manifest from '../module.js';
import lifecycle from './jobs.js';

export { coderabbitProvider, parseAgentOutput } from './coderabbit-provider.js';

export default defineApiModule({ manifest, lifecycle });
