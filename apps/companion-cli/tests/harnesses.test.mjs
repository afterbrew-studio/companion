import assert from 'node:assert/strict';
import test from 'node:test';
import { harnessChoices, NOTHING_INSTALLED, readHarnessOptions } from '../dist/harnesses.js';

/**
 * The first-run question about agent runtimes. What matters here is what the
 * operator can see before they tick a box, and that an instance which cannot
 * answer the question is never asked it.
 */

test('a ready runtime arrives ticked, one that would fail arrives unticked', () => {
  const [ready, broken] = harnessChoices([
    { id: 'moxxy', label: 'moxxy', state: 'ready', detail: null, fix: null },
    { id: 'claude-code', label: 'Claude Code', state: 'installed', detail: 'not signed in', fix: 'claude auth login' },
  ]);
  assert.equal(ready.checked, true);
  assert.equal(broken.checked, false);
});

test('what is wrong is in the row itself, not only in the description', () => {
  // The description is only shown while a row is highlighted, so someone
  // ticking a broken runtime would learn why after confirming.
  const [choice] = harnessChoices([
    { id: 'claude-code', label: 'Claude Code', state: 'installed', detail: 'not signed in', fix: 'claude auth login' },
  ]);
  assert.match(choice.name, /Claude Code/);
  assert.match(choice.name, /not signed in/);
  assert.match(choice.description, /claude auth login/);
});

test('a ready row says nothing beyond its name', () => {
  const [choice] = harnessChoices([{ id: 'moxxy', label: 'moxxy', state: 'ready', detail: null, fix: null }]);
  assert.equal(choice.name, 'moxxy');
  assert.equal(choice.description, undefined);
});

test('the empty-list copy names both installs and what each still needs', () => {
  // The one case that needs words: a question with no options is not a question.
  assert.match(NOTHING_INSTALLED, /@moxxy\/cli/);
  assert.match(NOTHING_INSTALLED, /@anthropic-ai\/claude-code/);
  assert.match(NOTHING_INSTALLED, /moxxy provision/);
  assert.match(NOTHING_INSTALLED, /claude auth login/);
});

test('a daemon that does not answer is not an error to report', async () => {
  // An instance without the execution module has no such question. Explaining
  // its absence would be worse than staying quiet.
  assert.equal(await readHarnessOptions('http://127.0.0.1:1', 'tok'), null);
});
