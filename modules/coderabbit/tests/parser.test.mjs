import assert from 'node:assert/strict';
import test from 'node:test';
import { codeRabbitEnvironment, parseAgentOutput } from '../dist/api/coderabbit-provider.js';

test('CodeRabbit JSONL becomes bounded Companion findings', () => {
  const output = [
    'human-readable prelude that must be ignored',
    JSON.stringify({
      type: 'finding',
      severity: 'critical',
      fileName: 'src/auth.ts',
      lineNumber: 42,
      comment: 'Authentication can be bypassed. Validate the signed session before loading the record.',
      suggestions: ['Move the lookup after session verification.'],
    }),
    JSON.stringify({ type: 'complete', status: 'review_completed', message: 'Review complete' }),
  ].join('\n');

  const parsed = parseAgentOutput(output);
  assert.equal(parsed.complete, true);
  assert.equal(parsed.error, null);
  assert.equal(parsed.findings.length, 1);
  assert.deepEqual(parsed.findings[0], {
    severity: 'blocker',
    title: 'Authentication can be bypassed.',
    file: 'src/auth.ts',
    line: 42,
    reason: 'Authentication can be bypassed. Validate the signed session before loading the record.',
    impact: 'Reported by CodeRabbit in src/auth.ts.',
    suggestion: 'Move the lookup after session verification.',
    confidence: 0.8,
  });
});

test('malformed JSONL is ignored but a structured terminal error survives', () => {
  const parsed = parseAgentOutput([
    '{not json',
    JSON.stringify({ type: 'error', error: 'review quota exhausted' }),
  ].join('\n'));
  assert.equal(parsed.complete, false);
  assert.equal(parsed.error, 'review quota exhausted');
  assert.deepEqual(parsed.findings, []);
});

test('a skipped review is distinct from an empty completed review', () => {
  const parsed = parseAgentOutput(JSON.stringify({
    type: 'complete',
    status: 'review_skipped',
    message: 'No committed changes',
  }));
  assert.equal(parsed.complete, true);
  assert.equal(parsed.skipped, true);
  assert.equal(parsed.summary, 'No committed changes');
});

test('the CLI receives runtime basics but not unrelated daemon credentials', () => {
  const environment = codeRabbitEnvironment({
    PATH: '/usr/bin',
    HOME: '/srv/companion',
    HTTPS_PROXY: 'https://proxy.example',
    GITHUB_TOKEN: 'github-secret',
    OPENAI_API_KEY: 'model-secret',
    COMPANION_SESSION_SECRET: 'session-secret',
    NODE_OPTIONS: '--require /tmp/inject.js',
  });

  assert.deepEqual(environment, {
    PATH: '/usr/bin',
    HOME: '/srv/companion',
    HTTPS_PROXY: 'https://proxy.example',
  });
});
