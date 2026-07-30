import assert from 'node:assert/strict';
import test from 'node:test';
import { harnessChoices, NOTHING_INSTALLED, readHarnessOptions } from '../dist/harnesses.js';

/**
 * The first-run question about agent runtimes. What matters here is what the
 * operator can see before they tick a box, and that an instance which cannot
 * answer the question is never asked it.
 */

const MOXXY = { id: 'moxxy', label: 'Moxxy', homepage: 'https://moxxy.ai', state: 'ready', detail: null, fix: null };
const CLAUDE = {
  id: 'claude-code',
  label: 'Claude Code',
  homepage: 'https://claude.com/claude-code',
  state: 'installed',
  detail: 'not signed in',
  fix: 'claude auth login',
};

test('a ready runtime arrives ticked, one that would fail arrives unticked', () => {
  const [ready, broken] = harnessChoices([MOXXY, CLAUDE]);
  assert.equal(ready.checked, true);
  assert.equal(broken.checked, false);
});

test('what is wrong is in the row itself, not only in the description', () => {
  // The description is only shown while a row is highlighted, so someone
  // ticking a broken runtime would learn why after confirming.
  const [choice] = harnessChoices([CLAUDE]);
  assert.match(choice.name, /Claude Code/);
  assert.match(choice.name, /not signed in/);
  assert.match(choice.description, /claude auth login/);
});

test("a ready row carries the runtime's own site, because this is where the name is met", () => {
  const [choice] = harnessChoices([MOXXY]);
  assert.equal(choice.name, 'Moxxy  (https://moxxy.ai)');
  // Nothing is wrong with it, so there is no fix to offer.
  assert.equal(choice.description, undefined);
});

test('a broken row spends that space on the fault instead, which is the more urgent of the two', () => {
  const [choice] = harnessChoices([CLAUDE]);
  assert.equal(choice.name.includes(CLAUDE.homepage), false);
});

test('the empty-list copy names every install and what each still needs', () => {
  // The one case that needs words: a question with no options is not a question.
  for (const expected of [
    /@moxxy\/cli/,
    /@anthropic-ai\/claude-code/,
    /@openai\/codex/,
    /moxxy provision/,
    /claude auth login/,
    /codex login/,
    /https:\/\/moxxy\.ai/,
  ]) {
    assert.match(NOTHING_INSTALLED, expected);
  }
});

test('a daemon that does not answer is not an error to report', async () => {
  // An instance without the execution module has no such question. Explaining
  // its absence would be worse than staying quiet.
  assert.equal(await readHarnessOptions('http://127.0.0.1:1', 'tok'), null);
});
