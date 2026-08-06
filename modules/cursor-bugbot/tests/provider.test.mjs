import assert from 'node:assert/strict';
import test from 'node:test';
import { cursorBugbotProvider } from '../dist/api/cursor-bugbot-provider.js';

test('Bugbot uses the documented GitHub comment and reports a hand-off, never a verdict', async () => {
  const comments = [];
  const result = await cursorBugbotProvider.review(
    { record: { id: 'cursor' }, secret: () => null },
    {
      progress: () => undefined,
      commentOnPullRequest: async (body) => {
        comments.push(body);
        return { url: 'https://github.com/acme/app/pull/7#issuecomment-1' };
      },
    },
  );

  assert.deepEqual(comments, ['cursor review']);
  assert.equal(result.kind, 'delegated');
  assert.equal(result.externalUrl, 'https://github.com/acme/app/pull/7#issuecomment-1');
  assert.equal('findings' in result, false);
});
