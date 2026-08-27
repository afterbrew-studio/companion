import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, insertTask } from './fixture.mjs';

/** `approveFlow` is dispatched, not awaited, by `onRunChanged`. */
const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * A worker that asks instead of guessing.
 *
 * The behaviour under test is not "a question is recorded" but "a question is
 * not a failure": charging it against the attempt ceiling would make guessing
 * the cheaper option, which is exactly the choice the rule exists to remove.
 */
const askedRun = (question) => ({
  'run-1': { outcome: `NEEDS-HUMAN: ${question}`, status: 'completed' },
});

test('a question parks the card without charging an attempt', async () => {
  const posted = [];
  const { store, makeService } = fixture({
    runRows: askedRun('Should a removed flag keep its stored value or be deleted?'),
    diff: async () => ({ diff: '' }),
    performForRepo: async (_purpose, _repo, action) => {
      await action({
        addLabels: async (repo, issue, labels) => posted.push({ kind: 'label', repo, issue, labels }),
        comment: async (repo, issue, body) => posted.push({ kind: 'comment', repo, issue, body }),
      });
      return { result: null, client: null, tried: [] };
    },
  });
  insertTask(store, { id: 'tsk-1', runId: 'run-1', status: 'in_progress', sourceIssueNumber: 42, attempts: 0 });

  const service = makeService();
  service.onRunChanged({ id: 'run-1', status: 'review' });
  await settle();

  const task = store.getTask('tsk-1');
  assert.equal(task.status, 'backlog', 'a question must park the card, not fail it');
  assert.equal(task.attempts, 0, 'a question must not consume an attempt');
  assert.match(task.lastError, /waiting on a human/);
  assert.equal(task.runId, null, 'the run is released');
});

test('the question reaches the source issue, labelled', async () => {
  const posted = [];
  const { store, makeService } = fixture({
    runRows: askedRun('Which of the two spellings is canonical?'),
    diff: async () => ({ diff: '' }),
    performForRepo: async (_purpose, _repo, action) => {
      await action({
        addLabels: async (repo, issue, labels) => posted.push({ kind: 'label', repo, issue, labels }),
        comment: async (repo, issue, body) => posted.push({ kind: 'comment', repo, issue, body }),
      });
      return { result: null, client: null, tried: [] };
    },
  });
  insertTask(store, { id: 'tsk-1', runId: 'run-1', status: 'in_progress', sourceIssueNumber: 42 });

  makeService().onRunChanged({ id: 'run-1', status: 'review' });
  await settle();

  const label = posted.find((p) => p.kind === 'label');
  const comment = posted.find((p) => p.kind === 'comment');
  assert.deepEqual(label.labels, ['tier:ai-needs-human']);
  assert.equal(label.issue, 42, 'the question goes to the issue, not a run log');
  assert.match(comment.body, /Which of the two spellings is canonical\?/);
  assert.match(comment.body, /remove the/, 'it must say how to unblock it');
});

test('a card with no source issue still parks', async () => {
  // The park is what stops the worker. Losing the comment is a lost question;
  // losing the park would be an agent that keeps retrying a decision it cannot
  // make.
  const { store, makeService } = fixture({
    runRows: askedRun('unanswerable'),
    diff: async () => ({ diff: '' }),
  });
  insertTask(store, { id: 'tsk-1', runId: 'run-1', status: 'in_progress', sourceIssueNumber: null });

  makeService().onRunChanged({ id: 'run-1', status: 'review' });
  await settle();
  assert.equal(store.getTask('tsk-1').status, 'backlog');
});

test('removing the label resumes the card and restores its budget', () => {
  const { store, makeService } = fixture({});
  insertTask(store, {
    id: 'tsk-1',
    status: 'backlog',
    sourceIssueNumber: 42,
    attempts: 2,
    lastError: 'waiting on a human: which spelling?',
  });

  const service = makeService();
  assert.equal(service.resumeAfterHumanAnswer('owner/repo', 42), true);
  const task = store.getTask('tsk-1');
  assert.equal(task.status, 'ready');
  assert.equal(task.attempts, 0, 'the answer gets a full budget, not the remainder');
  assert.equal(task.lastError, null);
});

test('removing the label does not un-park a card a person parked', () => {
  // Removing a label says nothing about a hand-parked card, and resuming it
  // would override a person's decision as a side effect of tidying labels.
  const { store, makeService } = fixture({});
  insertTask(store, { id: 'tsk-1', status: 'backlog', sourceIssueNumber: 42, lastError: null });

  assert.equal(makeService().resumeAfterHumanAnswer('owner/repo', 42), false);
  assert.equal(store.getTask('tsk-1').status, 'backlog');
});

test('an empty diff with no question is still a failed attempt', async () => {
  // The escalation must not swallow the ordinary no-changes case, which is a
  // real failure and should keep consuming attempts.
  const { store, makeService } = fixture({
    runRows: { 'run-1': { outcome: 'did some reading', status: 'completed' } },
    diff: async () => ({ diff: '' }),
  });
  insertTask(store, { id: 'tsk-1', runId: 'run-1', status: 'in_progress', sourceIssueNumber: 42, attempts: 0 });

  makeService().onRunChanged({ id: 'run-1', status: 'review' });
  await settle();
  const task = store.getTask('tsk-1');
  assert.notEqual(task.status, 'backlog', 'a plain no-diff run must not read as a question');
  assert.equal(task.attempts, 1, 'it must still consume an attempt');
});

test('applying the label by hand stops a card already in flight', async () => {
  // Without this the label is only honoured when the WORKER raises it: a person
  // noticing mid-flight that a task is underspecified would label the issue and
  // watch the agent carry on, which makes a stop look advisory.
  const discarded = [];
  const { store, makeService } = fixture({
    discard: async (runId) => discarded.push(runId),
  });
  insertTask(store, { id: 'tsk-1', runId: 'run-9', status: 'in_progress', sourceIssueNumber: 42 });

  const held = await makeService().holdForHumanAnswer('owner/repo', 42, 'alice marked it');
  assert.equal(held, true);
  const task = store.getTask('tsk-1');
  assert.equal(task.status, 'backlog');
  assert.equal(task.runId, null);
  assert.match(task.lastError, /waiting on a human/);
  assert.deepEqual(discarded, ['run-9'], 'the in-flight run is discarded, not left running');
});

test('holding does not disturb a finished card', async () => {
  // Re-parking a done card would undo a finished outcome.
  const { store, makeService } = fixture({});
  insertTask(store, { id: 'tsk-1', status: 'done', sourceIssueNumber: 42 });

  assert.equal(await makeService().holdForHumanAnswer('owner/repo', 42, 'late label'), false);
  assert.equal(store.getTask('tsk-1').status, 'done');
});

test('hold then resume returns the card to the queue', async () => {
  const { store, makeService } = fixture({ discard: async () => undefined });
  insertTask(store, { id: 'tsk-1', runId: 'run-9', status: 'in_progress', sourceIssueNumber: 42, attempts: 2 });
  const service = makeService();

  await service.holdForHumanAnswer('owner/repo', 42, 'needs a decision');
  assert.equal(store.getTask('tsk-1').status, 'backlog');

  assert.equal(service.resumeAfterHumanAnswer('owner/repo', 42), true);
  const task = store.getTask('tsk-1');
  assert.equal(task.status, 'ready');
  assert.equal(task.attempts, 0);
});
