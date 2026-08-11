import assert from 'node:assert/strict';
import test from 'node:test';
import { IntegrationUnavailableError } from '@companion/module-integrations/provider';
import { coderabbitProvider, parseAgentOutput } from '../dist/api/coderabbit-provider.js';

/** Drive the review flow with a canned CLI process result. */
function review(result) {
  return coderabbitProvider.review(null, {
    cwd: '/tmp/worktree',
    baseRef: 'main',
    signal: new AbortController().signal,
    progress: () => {},
    exec: {
      machine: 'test-machine',
      run: async () => ({ binary: 'cr', code: 0, stdout: '', stderr: '', timedOut: false, missing: false, ...result }),
    },
  });
}

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

test('a finding is titled by its point, not by the preamble every one shares', () => {
  // Shape the CLI actually emits: the human comment is absent and the codegen
  // instructions open with the boilerplate addressed to the applying agent.
  const parsed = parseAgentOutput(
    [
      JSON.stringify({
        type: 'finding',
        severity: 'minor',
        fileName: 'src/pages/Integrations.tsx',
        codegenInstructions:
          'Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.\n\nIn @src/pages/Integrations.tsx around lines 201 - 208, Add role="group" to the category filter container so its aria-label is exposed to assistive technology.',
      }),
      JSON.stringify({ type: 'complete', status: 'review_completed' }),
    ].join('\n'),
  );
  assert.equal(
    parsed.findings[0].title,
    'Add role="group" to the category filter container so its aria-label is exposed to assistive technology.',
  );
  // The instructions stay whole as the reason: the preamble is context for
  // whoever applies the fix, it just makes a useless title.
  assert.match(parsed.findings[0].reason, /^Verify each finding/);
});

test('a singular line location is stripped without treating malformed text as one', () => {
  const parsed = parseAgentOutput(
    [
      JSON.stringify({
        type: 'finding',
        severity: 'major',
        fileName: 'src/auth.ts',
        codegenInstructions: 'In src/auth.ts around line 42, Reject an expired session before loading user data.',
      }),
      JSON.stringify({
        type: 'finding',
        severity: 'major',
        fileName: 'src/other.ts',
        codegenInstructions: 'In src/other.ts around lines many, Keep this complete malformed location.',
      }),
    ].join('\n'),
  );
  assert.equal(parsed.findings[0].title, 'Reject an expired session before loading user data.');
  assert.equal(parsed.findings[1].title, 'In src/other.ts around lines many, Keep this complete malformed location.');
});

test('a pathological finding count is clamped with a truncation note, not rejected downstream', () => {
  const finding = (n) =>
    JSON.stringify({ type: 'finding', severity: 'minor', fileName: `src/f${n}.ts`, comment: `Finding ${n}.` });
  const lines = Array.from({ length: 600 }, (_, n) => finding(n));
  lines.push(JSON.stringify({ type: 'complete', status: 'review_completed', message: 'Review complete' }));
  const parsed = parseAgentOutput(lines.join('\n'));
  assert.equal(parsed.findings.length, 500);
  assert.equal(parsed.findings[0].title, 'Finding 0.');
  assert.match(parsed.summary, /600 findings/);
  assert.match(parsed.summary, /first 500/);
});

test('an oversized summary is clamped to the boundary schema bound', () => {
  const parsed = parseAgentOutput(
    JSON.stringify({ type: 'complete', status: 'review_completed', message: 'x'.repeat(25_000) }),
  );
  assert.ok(parsed.summary.length <= 20_000);
});

test('oversized file and title fields are clamped to the schema bounds', () => {
  const parsed = parseAgentOutput(
    JSON.stringify({ type: 'finding', severity: 'minor', fileName: `src/${'a'.repeat(1_500)}.ts` }),
  );
  assert.ok(parsed.findings[0].file.length <= 1_000);
  assert.ok(parsed.findings[0].title.length <= 180);
});

test('a structured error code classifies availability without reading the wording', async () => {
  const stdout = JSON.stringify({ type: 'error', code: 'unauthenticated', message: 'CodeRabbit could not proceed' });
  await assert.rejects(
    () => review({ code: 1, stdout }),
    (err) => err instanceof IntegrationUnavailableError && /could not proceed/.test(err.message),
  );
});

test('a structured substantive code is a hard failure even when the wording says connect', async () => {
  const stdout = JSON.stringify({ type: 'error', code: 'review_failed', message: 'could not connect the findings graph' });
  await assert.rejects(
    () => review({ code: 1, stdout }),
    (err) => !(err instanceof IntegrationUnavailableError) && /findings graph/.test(err.message),
  );
});

test('a substantive message merely containing connect-like words is a hard failure', async () => {
  await assert.rejects(
    () => review({ code: 1, stderr: 'reconnect strategy failed while rewriting the diff' }),
    (err) => !(err instanceof IntegrationUnavailableError) && /reconnect strategy failed/.test(err.message),
  );
});

test('an availability-worded message without a structured code still falls back', async () => {
  await assert.rejects(
    () => review({ code: 1, stderr: 'you are not signed in to CodeRabbit' }),
    (err) => err instanceof IntegrationUnavailableError,
  );
});

test('unknown vendor severities land mid-scale instead of demoting to nit', () => {
  const finding = (severity) =>
    JSON.stringify({ type: 'finding', severity, fileName: 'src/x.ts', comment: 'Something worth a look.' });
  const parsed = parseAgentOutput(
    [finding('high'), finding('blocker'), finding('trivial'), finding('info')].join('\n'),
  );
  assert.deepEqual(
    parsed.findings.map((entry) => entry.severity),
    ['major', 'major', 'nit', 'nit'],
  );
});
