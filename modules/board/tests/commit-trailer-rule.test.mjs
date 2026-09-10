import assert from 'node:assert/strict';
import test from 'node:test';
import { COMMIT_TRAILERS_FILE } from '@companion/module-operate/contract';
import { fixture, insertDeveloper, insertTask } from './fixture.mjs';

/**
 * A gate can demand a trailer the daemon writes, not the agent. The rule naming
 * the file is the only way an agent learns the channel exists, so an objective
 * without it meets such a gate with no legal move: editing the check is
 * forbidden and reverting the change abandons the work.
 */
test('the build objective tells the worker how to put a trailer on the commit', async () => {
  let objective = '';
  const { db, store, makeService } = fixture({
    createGoalRun: async (input) => {
      objective = input.objective;
      return { id: 'run-trailer', branch: 'task-branch' };
    },
  });
  insertDeveloper(store);
  insertTask(store);
  const service = makeService();

  store.updateTask('tsk-1', { status: 'ready', stage: 'build' });
  await service.tick();

  assert.match(objective, /demands a commit trailer/);
  // The prose and the file the daemon actually reads are one constant, so this
  // asserts the rendered name rather than a copy of it.
  assert.ok(
    objective.includes(COMMIT_TRAILERS_FILE),
    `the objective does not name ${COMMIT_TRAILERS_FILE}`,
  );

  service.dispose();
  db.close();
});
