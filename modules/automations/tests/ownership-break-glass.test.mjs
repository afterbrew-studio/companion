import assert from 'node:assert/strict';
import test from 'node:test';
import routeFactory from '../dist/api/routes.js';

const charlie = { username: 'charlie', displayName: 'Charlie', role: 'user' };
const bob = { username: 'bob', displayName: 'Bob', role: 'admin' };

function fixture({
  flow = null,
  unavailablePurpose = null,
  deniedPermissions = [],
  briefing = { cadence: 'daily', ownerId: 'alice' },
  workspaceRepos = ['acme/app'],
  webhookRemoteId = 73,
  accountKind = 'pat',
} = {}) {
  const state = {
    owner: 'alice',
    flow,
    briefing,
    admission: { repo: 'acme/app', paused: false, reason: null, pausedBy: null, pausedAt: null },
    briefingsRun: 0,
    row: {
      workspace_id: 'ws-1',
      default_branch: 'main',
      auto_triage: 1,
      digest_enabled: 1,
      stale_enabled: 0,
      pr_gate: 1,
      auto_merge: 1,
      review_replies: 1,
    },
  };
  const audits = [];
  let verified = 0;
  const verifiedPurposes = [];
  const verifiedNeeds = [];
  const fieldToRecord = {
    auto_triage: 'autoTriage',
    digest_enabled: 'digestEnabled',
    stale_enabled: 'staleSweepEnabled',
    pr_gate: 'prGateEnabled',
    auto_merge: 'autoMergeEnabled',
    review_replies: 'reviewRepliesEnabled',
  };
  const code = {
    repos: {
      get: (repo) => repo === 'acme/app' ? state.row : null,
      getRecord: () => ({
        fullName: 'acme/app',
        automationOwnerId: state.owner,
        ...Object.fromEntries(Object.entries(fieldToRecord).map(([field, record]) => [record, state.row[field] === 1])),
      }),
      inWorkspace: (repo, workspaceId) => repo === 'acme/app' && workspaceId === 'ws-1',
      automationOwner: () => state.owner,
      setAutomationOwner: (_repo, owner) => {
        state.owner = owner;
      },
      setAutomation: (_repo, field, on) => {
        state.row[field] = on ? 1 : 0;
      },
      getWebhookRegistration: () => ({
        ownerId: 'alice',
        accountId: 'gh-webhook',
        remoteId: webhookRemoteId,
        remoteError: null,
      }),
      listByWorkspace: () => workspaceRepos.map((full_name) => ({ full_name })),
    },
    githubAccounts: {
      verifiedClientFor: async (purpose, _fullName, ctx) => {
        verified += 1;
        verifiedPurposes.push(purpose);
        if (ctx?.need !== undefined) verifiedNeeds.push(`${purpose}:${ctx.need}`);
        return { client: purpose === unavailablePurpose ? null : {}, tried: purpose === unavailablePurpose ? ['gh-1'] : [] };
      },
      row: (id) => ({
        id,
        login: accountKind === 'app' ? 'afterbrew-studio' : 'bob',
        ownerId: 'bob',
        kind: accountKind,
        purposes: ['fetch', 'runs', 'pipelines', 'webhooks'],
      }),
    },
    pipelines: { create: () => ({ id: 'pipeline-1' }) },
  };
  const automations = {
    installWebhook: async (fullName) => ({ repo: fullName, remoteId: 99, remoteError: null }),
    contributorFlow: () => state.flow,
    listContributorFlows: () => state.flow ? [state.flow] : [],
    removeContributorFlow: () => {
      state.flow = null;
    },
    setContributorFlow: (policy) => {
      state.flow = policy;
      return policy;
    },
    admissionControls: () => [state.admission],
    admissionControl: () => state.admission,
    setAdmissionControl: (repo, paused, actor, reason) => {
      state.admission = paused
        ? { repo, paused: true, reason, pausedBy: actor, pausedAt: 1_000 }
        : { repo, paused: false, reason: null, pausedBy: null, pausedAt: null };
      return state.admission;
    },
    briefingSchedule: () => state.briefing,
    setBriefingCadence: (_workspaceId, cadence, ownerId) => {
      state.briefing = { cadence, ownerId: cadence === 'off' ? null : ownerId };
      return state.briefing;
    },
    runBriefing: async () => {
      state.briefingsRun += 1;
    },
  };
  const services = {
    automations: { automations, assistant: {} },
    operate: {
      webhookTunnel: {
        deliveryUrl: () => 'https://hooks.example.test/gh/webhooks/github/acme/app',
        enabled: () => true,
        start: async () => 'https://hooks.example.test/gh',
      },
    },
    code,
    workspace: {
      requireAccessible: (_user, id) => ({ id }),
      canAccessRepo: () => true,
    },
  };
  const hasPermission = (role, permission) =>
    !deniedPermissions.includes(permission) && (role === 'admin' || permission !== 'users:manage');
  const routes = routeFactory({
    services: { get: (id) => services[id] },
    rbac: {
      has: hasPermission,
      allows: (user, permission) =>
        hasPermission(user.role, permission)
        && (user.permissionScope === undefined || user.permissionScope.includes(permission)),
    },
    audit: { record: (event) => audits.push(event) },
    broadcast() {},
    isEnabled: () => true,
  });
  const run = (method, path, params, body, user) => {
    const target = routes.find((candidate) => candidate.method === method && candidate.path === path);
    assert.ok(target, `${method} ${path} route exists`);
    return target.run(params, new URLSearchParams(), body, user, null);
  };
  return { state, audits, verified: () => verified, verifiedPurposes, verifiedNeeds, run };
}

test('only break-glass authority may reduce foreign switches, and it preserves their owner', async () => {
  const fx = fixture();
  const path = '/api/repos/:owner/:name/automation';
  const params = { owner: 'acme', name: 'app' };

  await assert.rejects(() => fx.run('POST', path, params, { digest: false }, charlie), (err) => err.status === 403);
  assert.equal(fx.state.row.digest_enabled, 1);

  await fx.run('POST', path, params, { digest: false }, bob);
  assert.equal(fx.state.row.digest_enabled, 0);
  assert.equal(fx.state.owner, 'alice', 'a safe-off update must not assign the remaining work to the administrator');
  assert.equal(fx.verified(), 0, 'making work safer must remain possible after GitHub access is gone');
  assert.equal(fx.audits.at(-1).action, 'automation.break-glass-reduce');
});

test('a scoped operator may pause foreign intake, but only owner or break-glass may resume it', async () => {
  const fx = fixture({
    flow: {
      workspaceId: 'ws-1',
      repo: 'acme/app',
      mode: 'autonomous',
      actionableIssueKinds: ['bug'],
      queueIssues: true,
      autoApplyTriage: true,
      mergeMethod: 'squash',
      maxAttempts: 3,
      ownerId: 'alice',
      updatedAt: 1,
    },
  });
  const path = '/api/workspaces/:id/repos/:owner/:name/automation-admission';
  const params = { id: 'ws-1', owner: 'acme', name: 'app' };

  const paused = await fx.run('PUT', path, params, { paused: true, reason: 'runner incident' }, charlie);
  assert.equal(paused.control.paused, true);
  assert.equal(paused.control.pausedBy, 'charlie');
  assert.equal(fx.audits.at(-1).action, 'automation.admission.paused');

  await assert.rejects(
    () => fx.run('PUT', path, params, { paused: false }, charlie),
    (err) => err.status === 403,
  );
  assert.equal(fx.state.admission.paused, true);

  const resumed = await fx.run('PUT', path, params, { paused: false }, bob);
  assert.equal(resumed.control.paused, false);
  assert.equal(fx.audits.at(-1).action, 'automation.admission.resumed');
  assert.equal(fx.audits.at(-1).access, 'users:manage');
});

test('break-glass takeover revalidates the administrator before assigning enabled work', async () => {
  const fx = fixture();
  await fx.run(
    'POST',
    '/api/repos/:owner/:name/automation',
    { owner: 'acme', name: 'app' },
    { prGate: true },
    bob,
  );

  assert.equal(fx.verified(), 3);
  assert.deepEqual(fx.verifiedPurposes, ['fetch', 'runs', 'pipelines']);
  assert.equal(fx.state.owner, 'bob');
  assert.equal(fx.audits.at(-1).action, 'automation.break-glass-takeover');
});

test('an unavailable purpose account refuses takeover before changing switches', async () => {
  const fx = fixture({ unavailablePurpose: 'pipelines' });
  fx.state.row.pr_gate = 0;

  await assert.rejects(
    () => fx.run(
      'POST',
      '/api/repos/:owner/:name/automation',
      { owner: 'acme', name: 'app' },
      { prGate: true },
      bob,
    ),
    (err) => err.status === 400 && /pipelines account/.test(err.message),
  );
  assert.equal(fx.state.row.pr_gate, 0);
  assert.equal(fx.state.owner, 'alice');
});

test('scheduled digests require run action authority before any account probe', async () => {
  const fx = fixture({ deniedPermissions: ['runs:act'] });
  fx.state.owner = 'bob';
  fx.state.row.digest_enabled = 0;

  await assert.rejects(
    () => fx.run(
      'POST',
      '/api/repos/:owner/:name/automation',
      { owner: 'acme', name: 'app' },
      { digest: true },
      bob,
    ),
    (err) => err.status === 403 && /runs:act/.test(err.message),
  );
  assert.equal(fx.verified(), 0);
  assert.equal(fx.state.row.digest_enabled, 0);
});

test('stale schedules require issue visibility before any account probe', async () => {
  const fx = fixture({ deniedPermissions: ['issues:read'] });
  fx.state.owner = 'bob';
  fx.state.row.stale_enabled = 0;

  await assert.rejects(
    () => fx.run(
      'POST',
      '/api/repos/:owner/:name/automation',
      { owner: 'acme', name: 'app' },
      { staleSweep: true },
      bob,
    ),
    (err) => err.status === 403 && /issues:read/.test(err.message),
  );
  assert.equal(fx.verified(), 0);
  assert.equal(fx.state.row.stale_enabled, 0);
});

test('disabling a foreign contributor flow leaves independent switches with their former owner', async () => {
  const fx = fixture({
    flow: {
      workspaceId: 'ws-1',
      repo: 'acme/app',
      mode: 'autonomous',
      actionableIssueKinds: ['bug'],
      queueIssues: true,
      autoApplyTriage: true,
      mergeMethod: 'squash',
      maxAttempts: 3,
      ownerId: 'alice',
      updatedAt: 1,
    },
  });

  await fx.run(
    'PUT',
    '/api/workspaces/:id/repos/:owner/:name/contributor-flow',
    { id: 'ws-1', owner: 'acme', name: 'app' },
    { mode: 'off' },
    bob,
  );

  assert.equal(fx.state.flow, null);
  assert.equal(fx.state.row.auto_merge, 0);
  assert.equal(fx.state.owner, 'alice');
  assert.equal(fx.verified(), 0);
  assert.equal(fx.audits.at(-1).action, 'automation.break-glass-disable-flow');
});

test('a confirmed centrally managed webhook supports takeover without lending its account', async () => {
  const fx = fixture();
  const result = await fx.run(
    'PUT',
    '/api/workspaces/:id/repos/:owner/:name/contributor-flow',
    { id: 'ws-1', owner: 'acme', name: 'app' },
    { mode: 'autonomous' },
    bob,
  );

  assert.equal(result.flow.mode, 'autonomous');
  assert.equal(fx.state.flow.ownerId, 'bob');
  assert.deepEqual(fx.verifiedPurposes, ['fetch', 'runs', 'pipelines']);
  assert.equal(fx.state.row.auto_triage, 1);
  assert.equal(fx.state.row.pr_gate, 1);
  assert.equal(fx.state.row.auto_merge, 1);
  assert.equal(fx.state.owner, 'bob');
});

test('an unconfirmed GitHub-side webhook cannot enable a contributor flow', async () => {
  const fx = fixture({ webhookRemoteId: null });

  await assert.rejects(
    () => fx.run(
      'PUT',
      '/api/workspaces/:id/repos/:owner/:name/contributor-flow',
      { id: 'ws-1', owner: 'acme', name: 'app' },
      { mode: 'governed' },
      bob,
    ),
    (err) => err.status === 400 && /healthy GitHub-side webhook/.test(err.message),
  );
  assert.equal(fx.state.flow, null);
  assert.equal(fx.state.owner, 'alice');
});

test('watch-only is a complete break-glass shutdown including review replies', async () => {
  const fx = fixture();
  const result = await fx.run(
    'POST',
    '/api/repos/:owner/:name/preset',
    { owner: 'acme', name: 'app' },
    { preset: 'watch' },
    bob,
  );

  assert.equal(result.result.preset, 'watch');
  assert.equal(fx.verified(), 0);
  assert.equal(fx.state.owner, null);
  for (const field of ['auto_triage', 'digest_enabled', 'stale_enabled', 'pr_gate', 'auto_merge', 'review_replies']) {
    assert.equal(fx.state.row[field], 0, `${field} disabled`);
  }
  assert.equal(fx.audits.at(-1).action, 'automation.break-glass-disable-preset');
});

test('workspace briefing safe-off needs break-glass but no GitHub account', async () => {
  const path = '/api/workspaces/:id/briefing';
  const params = { id: 'ws-1' };
  const fx = fixture();

  await assert.rejects(() => fx.run('PUT', path, params, { cadence: 'off' }, charlie), (err) => err.status === 403);
  assert.deepEqual(fx.state.briefing, { cadence: 'daily', ownerId: 'alice' });

  const result = await fx.run('PUT', path, params, { cadence: 'off' }, bob);
  assert.deepEqual(result, { cadence: 'off', ownerId: null });
  assert.equal(fx.verified(), 0);
  assert.equal(fx.audits.at(-1).action, 'automation.break-glass-disable-workspace-briefing');
});

test('workspace briefing takeover verifies every repository before assigning its owner', async () => {
  const path = '/api/workspaces/:id/briefing';
  const params = { id: 'ws-1' };
  const unavailable = fixture({ unavailablePurpose: 'fetch' });

  await assert.rejects(
    () => unavailable.run('PUT', path, params, { cadence: 'weekly' }, bob),
    (err) => err.status === 400 && /cannot read acme\/app/.test(err.message),
  );
  assert.deepEqual(unavailable.state.briefing, { cadence: 'daily', ownerId: 'alice' });

  const ready = fixture();
  const result = await ready.run('PUT', path, params, { cadence: 'weekly' }, bob);
  assert.deepEqual(result, { cadence: 'weekly', ownerId: 'bob' });
  assert.equal(ready.verified(), 1);
  assert.deepEqual(ready.verifiedPurposes, ['fetch']);
  assert.equal(ready.audits.at(-1).action, 'automation.break-glass-takeover-workspace-briefing');
});

test('workspace briefing permissions fail before repository probes or report generation', async () => {
  const fx = fixture({ deniedPermissions: ['reports:read'] });

  await assert.rejects(
    () => fx.run('POST', '/api/workspaces/:id/briefing-now', { id: 'ws-1' }, undefined, bob),
    (err) => err.status === 403 && /reports:read/.test(err.message),
  );
  assert.equal(fx.verified(), 0);
  assert.equal(fx.state.briefingsRun, 0);
});

test('a GitHub App registers a webhook on write, not on admin', async () => {
  // `POST /repos/{owner}/{repo}/hooks` is governed by an App's `Webhooks: write`
  // permission, and that permission never sets `permissions.admin` on
  // `GET /repos/...`. Demanding the admin grade refused every App installation
  // before GitHub was asked - and the only way to satisfy it would be granting
  // `Administration: write`, which hands the agent's own credential authority
  // over branch protection and collaborators to buy a webhook.
  const fx = fixture({ accountKind: 'app' });
  await fx.run(
    'POST',
    '/api/repos/:owner/:name/webhook',
    { owner: 'acme', name: 'app' },
    { accountId: 'gh-1' },
    bob,
  );
  assert.ok(
    fx.verifiedNeeds.includes('webhooks:push'),
    `an App installation was graded against ${JSON.stringify(fx.verifiedNeeds)} rather than push`,
  );
  assert.ok(!fx.verifiedNeeds.includes('webhooks:admin'), 'an App was still required to be admin');
});

test('a personal token still needs admin to register a webhook', async () => {
  // Unchanged, and deliberately so: for a user token GitHub really does require
  // admin, and answers 404 without it - which reads as "missing repo".
  const fx = fixture({ accountKind: 'pat' });
  await fx.run(
    'POST',
    '/api/repos/:owner/:name/webhook',
    { owner: 'acme', name: 'app' },
    { accountId: 'gh-1' },
    bob,
  ).catch(() => undefined);
  assert.ok(
    fx.verifiedNeeds.includes('webhooks:admin'),
    `a personal token was graded against ${JSON.stringify(fx.verifiedNeeds)} rather than admin`,
  );
});
