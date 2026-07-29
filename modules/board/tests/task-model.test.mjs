import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, insertDeveloper, insertTask } from './fixture.mjs';

/** Queue a card in a given stage and let one tick dispatch it. */
async function dispatchOnce(store, makeService, overrides) {
  insertTask(store, overrides);
  insertDeveloper(store);
  const service = makeService();
  await service.tick();
  service.dispose();
}

/**
 * The three ways a card reaches an agent. A card set to a model and then moved
 * to repairing CI or addressing review must not quietly change model, which is
 * exactly the regression a build-only wiring would leave invisible.
 */
const STAGES = [
  { stage: 'build', card: {} },
  { stage: 'fix_ci', card: { stage: 'fix_ci', prNumber: 14, prUrl: 'https://example.test/pr/14' } },
  {
    stage: 'address_review',
    card: { stage: 'address_review', prNumber: 14, prUrl: 'https://example.test/pr/14' },
  },
];

for (const { stage, card } of STAGES) {
  test(`a card's model reaches the ${stage} dispatch path`, async () => {
    const { db, store, dispatched, makeService } = fixture();
    await dispatchOnce(store, makeService, { ...card, model: 'opus' });

    assert.deepEqual(dispatched, [
      { stage, repo: 'owner/repo', userId: 'owner-profile', task: 'board.worker', preferredModel: 'opus', ...(card.prNumber ? { prNumber: 14 } : {}) },
    ]);
    db.close();
  });

  test(`an unset card inherits on the ${stage} dispatch path`, async () => {
    const { db, store, dispatched, makeService } = fixture();
    await dispatchOnce(store, makeService, card);

    // null, never a copy of whatever board.worker is pinned to today: the
    // cascade has to keep resolving per run so repinning still moves the card.
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].stage, stage);
    assert.equal(dispatched[0].preferredModel, null);
    assert.equal(dispatched[0].task, 'board.worker');
    db.close();
  });
}

test('a card created without a model stores null, and one created with a model keeps it', () => {
  const { db, store, makeService } = fixture({ taskModelPin: () => 'sonnet' });
  const service = makeService();
  const base = {
    workspaceId: 'ws-1',
    repo: 'owner/repo',
    targetBranch: 'main',
    description: '',
    acceptance: '',
    specId: null,
    attachments: [],
    priority: 2,
    queue: false,
    createdBy: 'ana',
  };

  // The pin is live at creation time and must NOT be snapshotted into the row.
  assert.equal(service.createTask({ ...base, title: 'inherits' }).model, null);
  assert.equal(service.createTask({ ...base, title: 'blank' , model: '  ' }).model, null);
  assert.equal(service.createTask({ ...base, title: 'chosen', model: 'opus' }).model, 'opus');
  assert.equal(store.listTasks().find((t) => t.title === 'chosen').model, 'opus');
  service.dispose();
  db.close();
});

test('editing a card moves it to another model, and clearing returns it to inheriting', async () => {
  const { db, store, dispatched, makeService } = fixture();
  insertTask(store, { model: 'haiku' });
  insertDeveloper(store);
  const service = makeService();

  assert.equal(service.updateTask('tsk-1', { model: 'opus' }).model, 'opus');
  // An untouched field must not clear the choice.
  assert.equal(service.updateTask('tsk-1', { priority: 1 }).model, 'opus');
  await service.tick();
  assert.equal(dispatched[0].preferredModel, 'opus');

  assert.equal(service.updateTask('tsk-1', { model: null }).model, null);
  assert.equal(service.updateTask('tsk-1', { model: '' }).model, null);
  service.dispose();
  db.close();
});

test('the picker offers operate’s catalog and names what "inherit" resolves to', () => {
  let pin = 'sonnet';
  const catalog = [{ id: 'opus', contextWindow: 200_000, machines: ['runner-a'] }];
  const { db, makeService } = fixture({ servableModels: () => catalog, taskModelPin: () => pin });
  const service = makeService();

  const pinned = service.modelOptions('haiku');
  assert.deepEqual(pinned.models, catalog);
  assert.equal(pinned.workerModel, 'sonnet');
  assert.equal(pinned.defaultModel, 'haiku');

  // Read through, not cached: repinning board.worker changes what every unset
  // card is shown to inherit, with no board-side write.
  pin = null;
  assert.equal(service.modelOptions('haiku').workerModel, null);
  service.dispose();
  db.close();
});
