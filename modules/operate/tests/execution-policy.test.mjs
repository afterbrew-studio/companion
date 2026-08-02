import assert from 'node:assert/strict';
import test from 'node:test';
import { accessForRunKind } from '../dist/api/orchestrator.js';
import { claudeAccessArgs } from '../dist/exec/claude-code.js';
import { codexAccessArgs } from '../dist/exec/codex.js';
import { gatewayConfigYaml } from '../dist/exec/gateway-pool.js';

test('read-only product work receives the hard read-only execution profile', () => {
  for (const kind of ['analysis', 'triage', 'report']) {
    assert.equal(accessForRunKind(kind), 'read-only', kind);
  }
  for (const kind of ['interactive', 'fix', 'implement', 'command']) {
    assert.equal(accessForRunKind(kind), 'workspace-write', kind);
  }
  assert.equal(accessForRunKind('assistant'), 'trusted-assistant');
});

test('Codex uses its sandbox except for the scoped API assistant', () => {
  assert.deepEqual(codexAccessArgs('read-only'), [
    '--sandbox',
    'read-only',
    '--ask-for-approval',
    'never',
  ]);
  assert.deepEqual(codexAccessArgs('workspace-write'), [
    '--sandbox',
    'workspace-write',
    '--ask-for-approval',
    'never',
  ]);
  assert.deepEqual(codexAccessArgs('trusted-assistant'), ['--dangerously-bypass-approvals-and-sandbox']);
});

test('Claude read-only sessions cannot discover mutating or network tools', () => {
  assert.deepEqual(claudeAccessArgs('read-only'), [
    '--safe-mode',
    '--permission-mode',
    'dontAsk',
    '--tools',
    'Read',
    'Glob',
    'Grep',
  ]);
  const writable = claudeAccessArgs('workspace-write');
  assert.ok(writable.includes('--safe-mode'));
  assert.ok(writable.includes('Bash(git push:*)'));
});

test('moxxy read-only policy is immutable and denies every side-effect escape hatch', () => {
  const config = gatewayConfigYaml(50176, '/tmp/skills', null, 'read-only');
  for (const tool of [
    'Write',
    'Edit',
    'Bash',
    'web_fetch',
    'browser_session',
    'workflow_create',
    'dispatch_agent',
    'load_skill',
  ]) {
    assert.match(config, new RegExp(`name: "${tool}"`));
  }
  assert.match(config, /permissions:\n  deny:/);
});
