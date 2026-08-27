import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * Every objective that runs an agent on a PR branch carries the scope contract.
 *
 * Asserted against the source rather than a rendered prompt because the failure
 * this catches is an objective being ADDED without it. A test that renders the
 * four known ones would still pass on a fifth.
 *
 * The case that prompted it: a CI-repair run, asked to make a check pass on a
 * pull request about a documentation file, edited two GitHub Actions workflows.
 * "Make CI pass" without a boundary admits changing whatever is failing.
 */
const source = readFileSync(new URL('../src/api/fixes.ts', import.meta.url), 'utf8');

const objectives = [...source.matchAll(/^function (\w*[Oo]bjective)\(/gm)].map((m) => m[1]);

test('every PR-branch objective exists and is discoverable', () => {
  assert.ok(objectives.length >= 4, `expected at least four objectives, found ${objectives.join(', ')}`);
});

test('every objective appends the scope and escalation contract', () => {
  for (const name of objectives) {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf('\n}', start);
    const body = source.slice(start, end);
    assert.match(
      body,
      /\$\{SCOPE_AND_ESCALATION\}/,
      `${name} does not carry the scope contract; an agent running it may change anything`,
    );
  }
});

test('the contract forbids editing CI to make a check pass', () => {
  // The specific failure observed: the cheapest way to make a red check green is
  // to change the check, and that hides the evidence rather than fixing it.
  assert.match(source, /Do not edit CI configuration, workflows, build or lint settings/);
});

test('the contract uses the marker the board escalation reads', () => {
  // A different string here would mean the agent asks and nobody hears it: the
  // board would charge a failed attempt and drop the question.
  assert.match(source, /NEEDS-HUMAN:/);
});
