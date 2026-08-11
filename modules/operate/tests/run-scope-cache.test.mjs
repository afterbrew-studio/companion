import assert from 'node:assert/strict';
import test from 'node:test';
import { createRunScopeResolver } from '../dist/api/ws-scope.js';

/**
 * The per-run visibility cache must not grow for the whole module lifetime:
 * a terminal run.changed evicts its entry, and a FIFO cap bounds regrowth
 * from late lookups.
 */
function fixture() {
  const lookups = [];
  const services = {
    operate: {
      orchestrator: {
        getRun: (runId) => {
          lookups.push(runId);
          return { repo: 'acme/app', kind: 'analysis', userId: 'ana' };
        },
      },
      canSeeRun: () => true,
    },
    core: { activeUserRole: () => 'admin' },
  };
  const resolve = createRunScopeResolver({ services: { get: (id) => services[id] } });
  const runChanged = (id, status) =>
    resolve({ t: 'run.changed', run: { id, repo: 'acme/app', kind: 'analysis', userId: 'ana', status } });
  const event = (runId) => resolve({ t: 'event', runId });
  return { runChanged, event, lookups };
}

test('a terminal run.changed evicts the cached visibility entry', () => {
  const fx = fixture();

  fx.runChanged('run-1', 'running');
  fx.event('run-1');
  assert.deepEqual(fx.lookups, [], 'an active run answers from the cache');

  const scope = fx.runChanged('run-1', 'completed');
  assert.equal(typeof scope, 'function', 'the terminal message itself is still scoped');
  assert.equal(scope('ana'), true);

  fx.event('run-1');
  assert.deepEqual(fx.lookups, ['run-1'], 'after eviction a late event re-reads the store');
});

test('the cache is bounded even for runs that never reach a terminal status', () => {
  const fx = fixture();
  for (let index = 0; index < 600; index += 1) fx.runChanged(`run-${index}`, 'running');

  fx.event('run-599');
  assert.deepEqual(fx.lookups, [], 'recent entries stay cached');

  fx.event('run-0');
  assert.deepEqual(fx.lookups, ['run-0'], 'the oldest entries were evicted by the cap');
});
