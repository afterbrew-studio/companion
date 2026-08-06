import { defineJobs } from '@moxxy/companion-sdk/server';
import { coderabbitProvider } from './coderabbit-provider.js';

let unregister: (() => void) | null = null;

export default defineJobs({
  onEnable: (ctx) => {
    unregister?.();
    unregister = ctx.services.get('integrations').registerProvider(coderabbitProvider);
  },
  onDisable: () => {
    unregister?.();
    unregister = null;
  },
});
