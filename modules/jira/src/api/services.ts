import { defineServices } from '@moxxy/companion-sdk/server';
import { JiraService } from './jira-service.js';
import { JiraStore } from './jira-store.js';

export default defineServices((ctx) => {
  ctx.services.register(
    'jira',
    new JiraService(new JiraStore(ctx.db), ctx.services.get('integrations'), ctx.broadcast),
  );
});
