import { defineJobs } from '@moxxy/companion-sdk/server';
import { jiraAutomationProvider, jiraCloudProvider } from './providers.js';

let unregisterProviders: Array<() => void> = [];

export default defineJobs({
  onEnable: (ctx) => {
    for (const unregister of unregisterProviders) unregister();
    unregisterProviders = [];
    try {
      for (const provider of [jiraCloudProvider, jiraAutomationProvider]) {
        unregisterProviders.push(ctx.services.get('integrations').registerProvider(provider));
      }
    } catch (error) {
      for (const unregister of unregisterProviders.reverse()) unregister();
      unregisterProviders = [];
      throw error;
    }
    ctx.ws.registerScopeResolver('jira', (message) => {
      if (message.t !== 'jira.changed') return null;
      return (username) => {
        const role = ctx.services.get('core').activeUserRole(username);
        if (!role) return false;
        const user = { username, displayName: username, role };
        return (
          ctx.services.get('code').repos.inWorkspace(message.repo, message.workspaceId) &&
          ctx.services.get('workspace').canAccessWorkspace(user, message.workspaceId) &&
          ctx.services.get('workspace').canAccessRepo(user, message.repo)
        );
      };
    });
  },
  onDisable: (ctx) => {
    for (const unregister of unregisterProviders) unregister();
    unregisterProviders = [];
    ctx.ws.unregisterScopeResolver('jira');
  },
});
