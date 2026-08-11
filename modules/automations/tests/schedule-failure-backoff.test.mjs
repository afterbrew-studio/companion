import assert from 'node:assert/strict';
import test from 'node:test';
import { Automations } from '../dist/api/automations.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * 60_000;
const START = Date.UTC(2026, 7, 11, 8);

/**
 * The schedule cursor only advances on success, so a persistently failing
 * digest/briefing re-fired on every minute tick, inserting an inbox error per
 * attempt. Failures must back off (10 min doubling, capped) and notify at most
 * once per day per repo.
 */
function fixture({ digestRepo = 'acme/app', briefingWorkspace = null, failing = () => true } = {}) {
  const settings = new Map();
  const notifications = [];
  let digestAttempts = 0;
  let briefingAttempts = 0;
  const store = {
    settings: {
      get: (key) => settings.get(key) ?? null,
      set: (key, value) => settings.set(key, value),
    },
    notifications: {
      insert: (n) => notifications.push(n),
    },
    repos: {
      list: () =>
        digestRepo
          ? [{ full_name: digestRepo, automation_owner_id: 'alice', digest_enabled: 1, stale_enabled: 0, auto_merge: 0 }]
          : [],
      get: () => ({ workspace_id: 'ws-1' }),
    },
    issues: {
      listSince: () => {
        digestAttempts += 1;
        if (failing()) throw new Error('boom');
        return [];
      },
      listWorkspace: () => [],
    },
    prs: {
      list: () => [],
      listWorkspace: () => [],
    },
    runs: { list: () => [] },
    workspaces: {
      list: () => (briefingWorkspace ? [{ id: briefingWorkspace, visibility: 'public' }] : []),
      get: () => {
        briefingAttempts += 1;
        if (failing()) return undefined;
        return { id: briefingWorkspace, name: 'Workspace' };
      },
      isMember: () => true,
      metrics: () => ({ issuesOpened7d: 0, issuesClosed7d: 0, prsOpened7d: 0, prsClosed7d: 0 }),
    },
    reports: { insert: () => {} },
    isAdmissionPaused: () => false,
    listAllContributorFlows: () => [],
  };
  const automations = new Automations(
    store,
    /* orchestrator */ {},
    /* triage */ {},
    /* prReviews */ {},
    /* prChecks */ {},
    /* pipelines */ {},
    /* sync */ {},
    /* checkouts */ { hasClone: () => false },
    /* webhookTunnel */ {},
    /* proposals */ { list: () => [] },
    /* specs */ {},
    /* github */ () => null,
    /* board */ () => undefined,
    /* authorized */ () => true,
    /* audit */ () => {},
    /* broadcast */ () => {},
  );
  if (briefingWorkspace) {
    settings.set(`briefing:${briefingWorkspace}`, 'daily');
    settings.set(`briefingOwner:${briefingWorkspace}`, 'alice');
  }
  return {
    automations,
    settings,
    notifications,
    digestAttempts: () => digestAttempts,
    briefingAttempts: () => briefingAttempts,
  };
}

/** Advance mocked wall-clock to `now`, run one tick, drain the digest promise. */
function ticker(t, automations) {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return async (now) => {
    t.mock.timers.setTime(now);
    await automations.tick(now);
    await settle();
    await settle();
  };
}

test('a failing digest backs off instead of re-firing every minute tick', async (t) => {
  const fx = fixture();
  const tick = ticker(t, fx.automations);

  await tick(START);
  assert.equal(fx.digestAttempts(), 1);
  assert.equal(fx.notifications.length, 1, 'first failure lands in the inbox');
  assert.equal(fx.notifications[0].kind, 'error');

  for (let minute = 1; minute <= 9; minute += 1) await tick(START + minute * MINUTE);
  assert.equal(fx.digestAttempts(), 1, 'no retry inside the 10 minute backoff');
  assert.equal(fx.notifications.length, 1, 'no notification storm');

  await tick(START + 10 * MINUTE);
  assert.equal(fx.digestAttempts(), 2, 'retries once the backoff elapses');
  assert.equal(fx.notifications.length, 1, 'failure notification is rate-limited to one per day');

  await tick(START + 20 * MINUTE);
  assert.equal(fx.digestAttempts(), 2, 'second failure doubles the delay');
  await tick(START + 30 * MINUTE);
  assert.equal(fx.digestAttempts(), 3);

  await tick(START + DAY + 31 * MINUTE);
  assert.equal(fx.notifications.length, 2, 'a persistent failure surfaces again the next day');
});

test('digest success clears the backoff and resumes the daily schedule', async (t) => {
  let failing = true;
  const fx = fixture({ failing: () => failing });
  const tick = ticker(t, fx.automations);

  await tick(START);
  assert.equal(fx.digestAttempts(), 1);

  failing = false;
  await tick(START + 10 * MINUTE);
  assert.equal(fx.digestAttempts(), 2, 'the retry runs and succeeds');
  assert.equal(fx.settings.get('failCount:digest:acme/app'), '0');

  failing = true;
  await tick(START + 11 * MINUTE);
  assert.equal(fx.digestAttempts(), 2, 'success cursor holds the schedule for a day');
  await tick(START + 10 * MINUTE + DAY);
  assert.equal(fx.digestAttempts(), 3, 'next day the schedule fires without leftover backoff');
});

test('a failing briefing backs off the same way', async (t) => {
  const fx = fixture({ digestRepo: null, briefingWorkspace: 'ws-1' });
  const tick = ticker(t, fx.automations);

  await tick(START);
  assert.equal(fx.briefingAttempts(), 1);
  for (let minute = 1; minute <= 9; minute += 1) await tick(START + minute * MINUTE);
  assert.equal(fx.briefingAttempts(), 1, 'no retry inside the backoff window');
  await tick(START + 10 * MINUTE);
  assert.equal(fx.briefingAttempts(), 2);
});
