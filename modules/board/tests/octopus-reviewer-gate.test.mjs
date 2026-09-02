import assert from 'node:assert/strict';
import test from 'node:test';
import { octopusAdapterConfig, octopusLogin } from '../dist/api/octopus-adapter.js';
import { fixture, insertTask } from './fixture.mjs';

/**
 * The adapter call is dispatched, not awaited, and it makes a real request to an
 * unreachable host. Ticking the microtask queue is not enough to see it finish, so this
 * waits on the outcome rather than on a fixed number of turns - otherwise "no blocker yet"
 * and "no blocker ever" look identical and every assertion here passes vacuously.
 */
const until = async (predicate, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
};

const withAdapterEnv = (login, run) => {
  const prev = { ...process.env };
  process.env.COMPANION_OCTOPUS_URL = 'https://octopus.invalid';
  process.env.COMPANION_OCTOPUS_TOKEN = 'tok';
  if (login) process.env.COMPANION_OCTOPUS_LOGIN = login;
  else delete process.env.COMPANION_OCTOPUS_LOGIN;
  return Promise.resolve(run()).finally(() => {
    process.env = prev;
  });
};

const laneTask = (store, externalReviewLogin) =>
  insertTask(store, {
    status: 'in_review',
    stage: 'awaiting_review',
    prNumber: 14,
    prUrl: 'https://example.test/pr/14',
    automationPolicy: {
      autoReview: false,
      externalReviewLogin,
      autoMerge: false,
      mergeMethod: 'merge',
      autoFixCi: false,
      maxAttempts: 3,
    },
  });

/** The adapter reaching an unreachable host is what raises this blocker. */
const started = (store) => store.hasActiveBlocker('tsk-1', 'octopus_adapter');


/**
 * `autoReview: false` says somebody else reviews, not who. Starting Octopus for a flow that
 * nominated a person or another bot buys a review nobody asked for, and leaves a second
 * verdict to reconcile against the one that was wanted.
 */

test('the adapter carries an optional reviewer login', () => {
  const base = { COMPANION_OCTOPUS_URL: 'https://octopus.example', COMPANION_OCTOPUS_TOKEN: 'tok' };
  assert.equal(octopusAdapterConfig(base).login, null, 'absent means cannot tell');
  assert.equal(
    octopusAdapterConfig({ ...base, COMPANION_OCTOPUS_LOGIN: 'octopus-ab[bot]' }).login,
    'octopus-ab[bot]',
  );
  assert.equal(
    octopusAdapterConfig({ ...base, COMPANION_OCTOPUS_LOGIN: '   ' }).login,
    null,
    'whitespace is not a login',
  );
});

test('a login still requires the url and token, so it cannot half-configure the adapter', () => {
  assert.equal(octopusAdapterConfig({ COMPANION_OCTOPUS_LOGIN: 'octopus-ab[bot]' }), null);
});

test('a flow that nominated another reviewer does not start Octopus', async () => {
  await withAdapterEnv('octopus-ab[bot]', async () => {
    const { db, store, makeService } = fixture();
    laneTask(store, 'some-human');
    const service = makeService();
    await service.tick();
    // Wait the same budget the positive cases need. If the gate were absent the blocker
    // would appear inside it, so a clean pass here means the call was skipped rather than
    // merely slow.
    await until(() => started(store));
    service.dispose();
    assert.equal(started(store), false, 'Octopus must not be started for another reviewer');
    db.close();
  });
});

test('a flow that nominated Octopus does start it', async () => {
  // The guard test. Without it, a gate that refused every flow would satisfy the
  // assertion above just as happily.
  await withAdapterEnv('octopus-ab[bot]', async () => {
    const { db, store, makeService } = fixture();
    laneTask(store, 'octopus-ab[bot]');
    const service = makeService();
    await service.tick();
    await until(() => started(store));
    service.dispose();
    assert.equal(started(store), true, 'the adapter ran and failed to reach the host');
    db.close();
  });
});

test('an unset login cannot tell, so behaviour is unchanged', async () => {
  // A deployment that has not named its reviewer must not silently lose reviews.
  await withAdapterEnv(null, async () => {
    const { db, store, makeService } = fixture();
    laneTask(store, 'some-human');
    const service = makeService();
    await service.tick();
    await until(() => started(store));
    service.dispose();
    assert.equal(started(store), true);
    db.close();
  });
});

test('the [bot] suffix is not part of the comparison', async () => {
  await withAdapterEnv('octopus-ab', async () => {
    const { db, store, makeService } = fixture();
    laneTask(store, 'octopus-ab[bot]');
    const service = makeService();
    await service.tick();
    await until(() => started(store));
    service.dispose();
    assert.equal(started(store), true, 'same app, two spellings');
    db.close();
  });
});

test('the comparison is case-folded, because GitHub logins are', async () => {
  // The two sides arrive from independent unnormalised places: free-text API input and an
  // environment variable. Without folding, an operator typing a different case silently
  // drops the review Octopus was meant to do.
  await withAdapterEnv('Octopus-AB[bot]', async () => {
    const { db, store, makeService } = fixture();
    laneTask(store, 'octopus-ab[bot]');
    const service = makeService();
    await service.tick();
    await until(() => started(store));
    service.dispose();
    assert.equal(started(store), true, 'same account, different case, must still match');
    db.close();
  });
});

test('a nominated other reviewer is skipped even with no adapter configured', async () => {
  // The login is readable without a URL or token. Folding the two together meant an
  // unconfigured adapter could not answer who the reviewer was, so a flow that nominated
  // a person still collected a "waiting for Octopus" blocker on every pull request.
  const prev = { ...process.env };
  delete process.env.COMPANION_OCTOPUS_URL;
  delete process.env.COMPANION_OCTOPUS_TOKEN;
  process.env.COMPANION_OCTOPUS_LOGIN = 'octopus-ab[bot]';
  try {
    const { db, store, makeService } = fixture();
    laneTask(store, 'some-human');
    const service = makeService();
    await service.tick();
    await until(() => store.hasActiveBlocker('tsk-1', 'octopus_adapter'));
    service.dispose();
    assert.equal(
      store.hasActiveBlocker('tsk-1', 'octopus_adapter'),
      false,
      'no blocker for a reviewer this deployment was never asked to run',
    );
    db.close();
  } finally {
    process.env = prev;
  }
});

test('the login is readable without a url or token', () => {
  assert.equal(octopusLogin({ COMPANION_OCTOPUS_LOGIN: 'octopus-ab[bot]' }), 'octopus-ab[bot]');
  assert.equal(octopusLogin({}), null);
  assert.equal(octopusLogin({ COMPANION_OCTOPUS_LOGIN: '  ' }), null);
});
