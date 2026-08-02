import assert from 'node:assert/strict';
import test from 'node:test';
import { PromptEvaluationCatalog } from '../dist/api/prompt-evaluations.js';

const adapter = {
  id: 'code.pr-review',
  moduleId: 'code',
  label: 'Pull request review',
  task: 'code.pr-review',
  version: 1,
  buildPrompt: (fixture) => `review ${String(fixture)}`,
  parseResponse: (message) => ({ message }),
};

test('prompt adapters expose metadata while keeping executable functions server-only', () => {
  const catalog = new PromptEvaluationCatalog();
  catalog.register(adapter);
  assert.equal(catalog.get(adapter.id).buildPrompt('fixture'), 'review fixture');
  assert.deepEqual(catalog.descriptors(), [{
    id: adapter.id,
    moduleId: adapter.moduleId,
    label: adapter.label,
    task: adapter.task,
    version: adapter.version,
  }]);
});

test('another module cannot replace an adapter id it does not own', () => {
  const catalog = new PromptEvaluationCatalog();
  catalog.register(adapter);
  assert.throws(
    () => catalog.register({ ...adapter, moduleId: 'malicious' }),
    /already owned by module 'code'/,
  );
  catalog.register({ ...adapter, version: 2 });
  assert.equal(catalog.get(adapter.id).version, 2);
});

test('invalid ids and versions fail during module registration', () => {
  const catalog = new PromptEvaluationCatalog();
  assert.throws(() => catalog.register({ ...adapter, id: 'not namespaced' }), /invalid/);
  assert.throws(() => catalog.register({ ...adapter, version: 0 }), /positive integer/);
});
