import assert from 'node:assert/strict';
import test from 'node:test';
import { Pipelines } from '../dist/api/pipelines.js';

const pipeline = (id, fields = {}) => ({
  id,
  workspaceId: 'ws-1',
  type: 'pr',
  name: id,
  description: '',
  steps: [],
  autoRunOnPrOpen: false,
  autoRunOnPrUpdate: false,
  createdAt: 1,
  updatedAt: 1,
  ...fields,
});

function fixture(records) {
  const engine = new Pipelines(
    {
      store: {
        repos: { workspaceIds: () => ['ws-1'] },
        pipelines: { list: () => records, markInterruptedRuns: () => 0 },
      },
      orchestrator: {},
      checkouts: {},
      github: () => null,
      checks: {},
      reviews: {},
      fixes: {},
      slop: () => null,
      moduleConfig: { get: () => null },
      secrets: {},
      audit: () => undefined,
      authorized: () => true,
      canAccessWorkspace: () => true,
    },
    () => undefined,
  );
  const starts = [];
  engine.start = (...args) => {
    starts.push(args);
    return {};
  };
  return { engine, starts };
}

test('new commits run update-enabled pipelines without replaying open-only pipelines', () => {
  const { engine, starts } = fixture([
    pipeline('open-only', { autoRunOnPrOpen: true }),
    pipeline('every-head', { autoRunOnPrOpen: true, autoRunOnPrUpdate: true }),
    pipeline('updates-only', { autoRunOnPrUpdate: true }),
  ]);

  engine.autoRunForPr('acme/app', 17, 'alice', 'pr-updated');

  assert.deepEqual(
    starts.map(([id, repo, number, trigger, owner]) => ({ id, repo, number, trigger, owner })),
    [
      { id: 'every-head', repo: 'acme/app', number: 17, trigger: 'pr-updated', owner: 'alice' },
      { id: 'updates-only', repo: 'acme/app', number: 17, trigger: 'pr-updated', owner: 'alice' },
    ],
  );
});

test('opening a PR remains independent from update-only policy', () => {
  const { engine, starts } = fixture([
    pipeline('open-only', { autoRunOnPrOpen: true }),
    pipeline('updates-only', { autoRunOnPrUpdate: true }),
  ]);

  engine.autoRunForPr('acme/app', 17, 'alice');
  assert.deepEqual(starts.map(([id]) => id), ['open-only']);
});

test('admission reports when a started pipeline already owns the AI review', () => {
  const reviewStep = {
    type: 'inline',
    step: {
      kind: 'ai-review',
      name: 'Evidence review',
      onFailure: 'halt',
      config: { post: false, failOn: 'never' },
    },
  };
  const { engine } = fixture([
    pipeline('review', { autoRunOnPrOpen: true, steps: [reviewStep] }),
  ]);

  assert.deepEqual(engine.autoRunForPr('acme/app', 17, 'alice'), {
    started: 1,
    includesReview: true,
    failures: [],
  });
});

test('automatic admission returns bounded failures instead of hiding them in logs', () => {
  const { engine } = fixture([
    pipeline('broken', { autoRunOnPrOpen: true }),
  ]);
  engine.start = () => {
    throw new Error('owner lost pipelines:run');
  };

  assert.deepEqual(engine.autoRunForPr('acme/app', 17, 'alice'), {
    started: 0,
    includesReview: false,
    failures: ['broken: Error: owner lost pipelines:run'],
  });
});
