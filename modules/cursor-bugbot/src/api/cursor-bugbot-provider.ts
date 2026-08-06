import type { IntegrationProviderAdapter } from '@companion/module-integrations/provider';

/** Bugbot is a GitHub App, not a local CLI. The documented on-demand surface
 * is a PR comment, so Companion models it as a delegated review instead of
 * pretending it can synchronously collect findings or produce a gate verdict. */
export const cursorBugbotProvider: IntegrationProviderAdapter = {
  descriptor: {
    id: 'cursor.bugbot',
    moduleId: 'cursor-bugbot',
    vendor: 'Cursor',
    title: 'Cursor Bugbot',
    description: 'Request an on-demand Bugbot review on GitHub and track the hand-off in Companion.',
    category: 'review',
    capabilities: ['code-review'],
    scopes: ['workspace', 'repository'],
    connectionMode: 'required',
    execution: 'delegated',
    fields: [],
    docsUrl: 'https://docs.cursor.com/bugbot',
    setup:
      'Install and configure the Cursor Bugbot GitHub App for the repository, then create this connection to enable delegated reviews.',
  },

  probe: async () => ({
    status: 'unknown',
    message: 'Bugbot installation is verified only when Companion requests a review on a real pull request.',
    checkedAt: Date.now(),
  }),

  review: async (_connection, request) => {
    request.progress('Requesting Cursor Bugbot review on GitHub');
    const comment = await request.commentOnPullRequest('cursor review');
    return {
      kind: 'delegated',
      summary: 'Cursor Bugbot was asked to review this pull request. Its findings will arrive on GitHub.',
      externalUrl: comment.url,
    };
  },
};
