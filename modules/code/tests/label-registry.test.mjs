import assert from 'node:assert/strict';
import test from 'node:test';
import {
  copyBothScopeLabels,
  filterProposedLabels,
  loadLabelRegistry,
  parseLabelRegistry,
} from '../dist/api/label-registry.js';

const RAYF_SHAPED = JSON.stringify({
  labels: [
    { name: 'tier:ai', scope: 'both', status: 'active' },
    { name: 'complexity:tiny', scope: 'both', status: 'active' },
    { name: 'area:governance', scope: 'both', status: 'active' },
    { name: 'agent:ready', scope: 'issue', status: 'active' },
    { name: 'review:ai', scope: 'pr', status: 'active' },
    { name: 'review:none', scope: 'pr', status: 'active' },
    { name: 'bug', scope: 'issue', status: 'active' },
    { name: 'test', scope: 'issue', status: 'retiring' },
    { name: 'docs', scope: 'issue', status: 'retiring' },
    { name: 'model:MiniMax-M3', scope: 'pr', status: 'retiring' },
  ],
});

test('a model that invents test, bug, or agent-ready applies none of them', () => {
  const entries = parseLabelRegistry(RAYF_SHAPED);
  assert.deepEqual(
    filterProposedLabels(['test', 'bug', 'agent-ready', 'docs'], entries, 'issue'),
    [],
  );
});

test('review: is not applied from model output even when active', () => {
  const entries = parseLabelRegistry(RAYF_SHAPED);
  assert.deepEqual(
    filterProposedLabels(['review:none', 'review:ai', 'ready-to-merge'], entries, 'pr'),
    [],
  );
});

test('filer families are never applied from model output even when active', () => {
  const entries = parseLabelRegistry(RAYF_SHAPED);
  assert.deepEqual(
    filterProposedLabels(['tier:ai', 'complexity:tiny', 'agent:ready', 'P1'], entries, 'issue'),
    [],
  );
});

test('a missing registry file does not call addLabels', async () => {
  const added = [];
  const source = {
    repo: async () => ({ default_branch: 'main' }),
    repoTextFiles: async () => new Map(),
  };
  await assert.rejects(() => loadLabelRegistry(source, 'acme/app'), /missing/);
  assert.deepEqual(added, []);
});

test('scope:both labels copy from the issue onto the pull request', () => {
  const entries = parseLabelRegistry(RAYF_SHAPED);
  assert.deepEqual(
    copyBothScopeLabels(['tier:ai', 'agent:ready', 'bug', 'complexity:tiny'], entries),
    ['tier:ai', 'complexity:tiny'],
  );
});
