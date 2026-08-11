import assert from 'node:assert/strict';
import test from 'node:test';
import routeFactory from '../dist/api/routes.js';

const alice = { username: 'alice', displayName: 'Alice', role: 'admin' };

/**
 * The synchronous run route is awaited by its HTTP request, and Node's default
 * requestTimeout kills the socket at 300 s: the schema must refuse anything at
 * or above that. The skill preload parameter must enforce skills:manage server
 * side; hiding the picker client side is not a boundary.
 */
function fixture({ allows = () => true } = {}) {
  const runs = [];
  const services = {
    operate: {
      checkouts: { hasClone: () => true, cloneDir: () => '/clones/acme/app' },
      skills: { get: (name) => ({ name, description: '', content: 'skill body' }) },
      orchestrator: {
        runOneShot: async (opts) => {
          runs.push(opts);
          return { runId: 'run-1', finalMessage: 'would do nothing' };
        },
      },
    },
    workspace: { canAccessRepo: () => true },
    playground: { evaluations: {}, production: {} },
  };
  const routes = routeFactory({
    services: { get: (id) => services[id], tryGet: (id) => services[id] },
    rbac: { has: () => true, allows },
    broadcast: () => {},
    audit: { record: () => {} },
    isEnabled: () => true,
  });
  const run = (body, user = alice) => {
    const target = routes.find((candidate) => candidate.method === 'POST' && candidate.path === '/api/playground/run');
    assert.ok(target, 'run route exists');
    return target.run({}, new URLSearchParams(), body, user, null, '127.0.0.1');
  };
  return { run, runs };
}

test('run timeout is capped below the 5-minute socket limit', async () => {
  const fx = fixture();
  await fx.run({ prompt: 'try something', repo: 'acme/app', timeoutMs: 270_000 });
  assert.equal(fx.runs.at(-1).timeoutMs, 270_000);

  for (const timeoutMs of [300_000, 600_000]) {
    await assert.rejects(() => fx.run({ prompt: 'try something', repo: 'acme/app', timeoutMs }));
  }
  assert.equal(fx.runs.length, 1, 'over-limit timeouts never start a run');
});

test('preloading a skill requires skills:manage server-side', async () => {
  const fx = fixture({ allows: (_user, permission) => permission !== 'skills:manage' });
  await assert.rejects(
    () => fx.run({ prompt: 'dry-run it', repo: 'acme/app', skill: 'review-checklist' }),
    (err) => err.status === 403 && /skills:manage/.test(err.message),
  );
  assert.equal(fx.runs.length, 0);

  await fx.run({ prompt: 'plain run without a skill', repo: 'acme/app' });
  assert.equal(fx.runs.length, 1, 'the route itself stays open without the preload');

  const open = fixture();
  await open.run({ prompt: 'dry-run it', repo: 'acme/app', skill: 'review-checklist' });
  assert.equal(open.runs.length, 1, 'holders of skills:manage keep the preload');
});
