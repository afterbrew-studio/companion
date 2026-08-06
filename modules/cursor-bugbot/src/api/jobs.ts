import { defineJobs } from '@moxxy/companion-sdk/server';
import { cursorBugbotProvider } from './cursor-bugbot-provider.js';

let unregister: (() => void) | null = null;

export default defineJobs({
  onEnable: (ctx) => {
    unregister?.();
    unregister = ctx.services.get('integrations').registerProvider(cursorBugbotProvider);
  },
  onDisable: () => {
    unregister?.();
    unregister = null;
  },
});
