import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, insertDeveloper, insertTask } from './fixture.mjs';

/**
 * The board's no-diff check is the one consumer that must keep telling a run
 * that DIED apart from one that ran and honestly changed nothing. It does that
 * by reading the `fatal: ` prefix the orchestrator writes onto the run outcome,
 * so anything that changes how errors are classified has to leave this intact.
 */
const inProgress = (store, runId) => {
  insertDeveloper(store);
  insertTask(store, { status: 'in_progress', stage: 'build', runId, assignedWorkerId: 'wkr-1' });
};

/** The run finished its turn: the board goes looking for a diff to push. */
const finished = (runId) => ({
  id: runId,
  status: 'review',
  kind: 'implement',
  repo: 'owner/repo',
  outcome: null,
});

test('a run that died on a fatal provider error is reported as dead', async () => {
  const { db, store, makeService } = fixture({
    runRows: {
      'run-1': {
        outcome:
          'fatal: provider kept returning a retryable error 6 times in a row ' +
          '(last: Our servers are currently overloaded. Please try again later.); ' +
          'giving up rather than hammering the provider.',
      },
    },
  });
  inProgress(store, 'run-1');

  const service = makeService();
  service.onRunChanged(finished('run-1'));
  await new Promise((resolve) => setImmediate(resolve));
  service.dispose();

  const task = store.getTask('tsk-1');
  assert.match(task.lastError, /^agent run died/, 'a dead run must not read as "changed nothing"');
  assert.match(task.lastError, /overloaded/, "the provider's own reason is carried through");
  db.close();
});

test('a run that lived and changed nothing is reported as changing nothing', async () => {
  // Same code path, same empty diff, no fatal outcome: this is the case the
  // `fatal: ` prefix exists to separate, so both halves are asserted together.
  const { db, store, makeService } = fixture({ runRows: { 'run-1': { outcome: null } } });
  inProgress(store, 'run-1');

  const service = makeService();
  service.onRunChanged(finished('run-1'));
  await new Promise((resolve) => setImmediate(resolve));
  service.dispose();

  const task = store.getTask('tsk-1');
  assert.equal(task.lastError, 'agent finished without producing any changes');
  db.close();
});

test('a run whose only errors were recoverable is not treated as dead', async () => {
  // moxxy's own provider retries never reach the run outcome, so a card whose
  // agent rode out an overload and then genuinely produced nothing must get
  // the honest "changed nothing", not "died".
  const { db, store, makeService } = fixture({ runRows: { 'run-1': { outcome: null } } });
  inProgress(store, 'run-1');

  const service = makeService();
  service.onRunChanged(finished('run-1'));
  await new Promise((resolve) => setImmediate(resolve));
  service.dispose();

  assert.doesNotMatch(store.getTask('tsk-1').lastError, /died/);
  db.close();
});
