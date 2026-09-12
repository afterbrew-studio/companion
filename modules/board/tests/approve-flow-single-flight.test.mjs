import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, insertDeveloper, insertTask } from './fixture.mjs';

/**
 * A run reaches the approve flow from two independent triggers, and both firing
 * for the same run makes them disagree about one fact: the first publishes,
 * which commits the working tree, and the second reads the now-empty diff as
 * "the agent produced nothing" and charges a failed attempt. The card then
 * retries work it had already pushed and opened the pull request twice.
 */
test('a run is approved once, however many triggers fire', async () => {
  let diffCalls = 0;
  const { db, store, makeService } = fixture({
    diff: async () => {
      diffCalls += 1;
      // Empty on every call after the first, which is what publishing leaves
      // behind: the change is in a commit, not in the working tree.
      return { diff: diffCalls === 1 ? 'diff --git a/x b/x\n+x\n' : '' };
    },
  });
  insertDeveloper(store);
  insertTask(store);
  const service = makeService();
  store.updateTask('tsk-1', { status: 'in_progress', stage: 'build', runId: 'run-1' });

  // Both triggers fire at once, as they do in production. What happens AFTER
  // the diff (publishing) is not this test's subject and is not stubbed, so a
  // throw from there is swallowed: the property under test is how many times
  // the flow got that far.
  await Promise.all([
    service.approveFlow('tsk-1', 'run-1').catch(() => undefined),
    service.approveFlow('tsk-1', 'run-1').catch(() => undefined),
  ]);

  assert.equal(diffCalls, 1, `the approve flow read the diff ${diffCalls} times; concurrent triggers must collapse to one`);

  service.dispose();
  db.close();
});
