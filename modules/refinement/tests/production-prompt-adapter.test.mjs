import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRefinementEvaluationPrompt,
  parseDecomposition,
  REFINEMENT_DECOMPOSITION_PROMPT_VERSION,
} from '../dist/api/refinement-service.js';

test('refinement evaluation replays the cached-context production contract', () => {
  const prompt = buildRefinementEvaluationPrompt({
    title: 'Saved filters',
    story: 'A maintainer can save, apply and delete a private filter.',
    branch: 'main',
    methodId: 'builtin-vertical-slices',
    specs: [],
    docs: [],
    repositorySnapshot: 'The code module owns PR filters and uses SQLite plus React.',
  });
  assert.equal(REFINEMENT_DECOMPOSITION_PROMPT_VERSION, 1);
  assert.match(prompt, /repository discovery is already complete/i);
  assert.match(prompt, /Vertical slices \(INVEST\)/);

  const parsed = parseDecomposition(JSON.stringify({
    summary: 'Deliver private saved filters in vertical slices.',
    tasks: [
      { title: 'Save a filter', description: 'Add the vertical slice.', acceptance: '- Persists privately', priority: 0, dependsOn: [] },
      { title: 'Apply a filter', description: 'Restore list state.', acceptance: '- Restores all fields', priority: 1, dependsOn: [0] },
      { title: 'Manage filters', description: 'Rename and delete.', acceptance: '- Confirms deletion', priority: 1, dependsOn: [0] },
    ],
  }));
  assert.equal(parsed.tasks.length, 3);
});
