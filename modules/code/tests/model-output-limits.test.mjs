import assert from 'node:assert/strict';
import test from 'node:test';
import { parseVerdictWithFindings } from '../dist/api/pr-reviews.js';
import { parseVerdict as parseTriageVerdict } from '../dist/api/triage.js';

test('PR review output is bounded before it reaches storage or the UI', () => {
  const base = {
    summary: 'Focused change with one actionable finding.',
    risk: 'medium',
    recommendation: 'request_changes',
    findings: ['Add a regression test for the failure path.'],
    reviewBody: 'The implementation is close, but its failure path is untested.',
  };
  assert.equal(parseVerdictWithFindings(JSON.stringify(base)).findings.length, 1);
  assert.throws(() => parseVerdictWithFindings(JSON.stringify({ ...base, reviewBody: 'x'.repeat(20_001) })));
  assert.throws(() => parseVerdictWithFindings(JSON.stringify({ ...base, findings: ['x'.repeat(1001)] })));
});

test('issue triage output rejects unbounded prose and invalid duplicate ids', () => {
  const base = {
    summary: 'The report describes a reproducible bug.',
    severity: 'medium',
    kind: 'bug',
    labels: ['bug'],
    duplicateOf: null,
    needsInfo: false,
    draftReply: 'Thanks — the described path is actionable.',
  };
  assert.equal(parseTriageVerdict(JSON.stringify(base)).kind, 'bug');
  assert.throws(() => parseTriageVerdict(JSON.stringify({ ...base, draftReply: 'x'.repeat(10_001) })));
  assert.throws(() => parseTriageVerdict(JSON.stringify({ ...base, duplicateOf: -1 })));
});
