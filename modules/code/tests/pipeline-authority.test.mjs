import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import migrations from '../dist/api/migrations.js';
import { PipelinesStore } from '../dist/api/pipelines-store.js';
import { Pipelines } from '../dist/api/pipelines.js';

function fixture() {
  const db = new Database(':memory:');
  for (const migration of migrations) migration.up(db);
  const pipelines = new PipelinesStore(db);
  pipelines.insert({
    id: 'pipeline-label',
    workspaceId: 'ws-private',
    type: 'pr',
    name: 'Governed label',
    description: '',
    steps: [
      {
        type: 'inline',
        step: {
          kind: 'label',
          name: 'Apply decision',
          onFailure: 'halt',
          requiresApproval: true,
          config: { labels: ['reviewed'] },
        },
      },
    ],
    autoRunOnPrOpen: false,
    autoRunOnPrUpdate: false,
    createdAt: 1,
    updatedAt: 1,
  });
  pipelines.insert({
    id: 'pipeline-quality',
    workspaceId: 'ws-private',
    type: 'pr',
    name: 'Contribution quality',
    description: '',
    steps: [
      {
        type: 'inline',
        step: {
          kind: 'slop-check',
          name: 'Assess contribution',
          onFailure: 'halt',
          config: { threshold: 70 },
        },
      },
    ],
    autoRunOnPrOpen: false,
    autoRunOnPrUpdate: false,
    createdAt: 1,
    updatedAt: 1,
  });
  let workspaceAllowed = true;
  let repoInWorkspace = true;
  let writesAllowed = true;
  let qualityAllowed = true;
  let labels = 0;
  let detections = 0;
  const engine = new Pipelines(
    {
      store: {
        pipelines,
        prs: {
          get: () => ({
            repo: 'acme/app',
            number: 7,
            title: 'Change',
            author: 'contributor',
            headSha: 'abc123',
            baseRef: 'main',
          }),
        },
        repos: {
          get: () => null,
          workspaceIds: () => ['ws-private'],
          inWorkspace: () => repoInWorkspace,
        },
      },
      orchestrator: { runners: { backend: () => ({}) } },
      checkouts: {},
      github: () => ({
        addLabels: async () => {
          labels += 1;
        },
      }),
      checks: {},
      reviews: {},
      fixes: {},
      slop: () => ({
        detectForGate: async () => {
          detections += 1;
          throw new Error('should not reach the quality service in an authority test');
        },
      }),
      moduleConfig: { get: () => null },
      secrets: { get: () => null, set: () => undefined, delete: () => undefined, keys: () => [] },
      audit: () => undefined,
      authorized: (_user, permission) =>
        (permission !== 'prs:act' || writesAllowed) &&
        (permission !== 'slop:act' || qualityAllowed),
      canAccessWorkspace: () => workspaceAllowed,
    },
    () => undefined,
  );
  return {
    db,
    engine,
    pipelines,
    labels: () => labels,
    detections: () => detections,
    revokeWrites: () => {
      writesAllowed = false;
    },
    revokeQuality: () => {
      qualityAllowed = false;
    },
    revokeWorkspace: () => {
      workspaceAllowed = false;
    },
    detachRepo: () => {
      repoInWorkspace = false;
    },
  };
}

test('a pipeline cannot cross into a shared repository workspace the owner cannot access', () => {
  const fx = fixture();
  fx.revokeWorkspace();

  assert.throws(
    () => fx.engine.start('pipeline-label', 'acme/app', 7, 'manual', 'alice'),
    /no longer has access to pipeline workspace ws-private/,
  );
  assert.equal(fx.pipelines.listRunsForPr('acme/app', 7).length, 0);
  fx.db.close();
});

test('a pipeline cannot be applied to a repository outside its own workspace', () => {
  const fx = fixture();
  fx.detachRepo();

  assert.throws(
    () => fx.engine.start('pipeline-label', 'acme/app', 7, 'manual', 'alice'),
    /does not belong to pipeline workspace ws-private/,
  );
  assert.equal(fx.pipelines.listRunsForPr('acme/app', 7).length, 0);
  fx.db.close();
});

test('revoking write authority while approval waits prevents the delayed GitHub mutation', async () => {
  const fx = fixture();
  const run = fx.engine.start('pipeline-label', 'acme/app', 7, 'manual', 'alice');
  assert.equal(fx.pipelines.getRun(run.id).steps[0].status, 'awaiting');

  fx.revokeWrites();
  assert.equal(fx.engine.resolveApproval(run.id, 0, true), true);
  await new Promise((resolve) => setImmediate(resolve));

  const stored = fx.pipelines.getRun(run.id);
  assert.equal(stored.status, 'error');
  assert.match(stored.steps[0].summary, /no longer holds prs:act/);
  assert.equal(fx.labels(), 0);
  fx.db.close();
});

test('a pipeline cannot use an optional module after its domain permission is revoked', () => {
  const fx = fixture();
  fx.revokeQuality();

  assert.throws(
    () => fx.engine.start('pipeline-quality', 'acme/app', 7, 'manual', 'alice'),
    /no longer holds slop:act/,
  );
  assert.equal(fx.pipelines.listRunsForPr('acme/app', 7).length, 0);
  assert.equal(fx.detections(), 0);
  fx.db.close();
});
