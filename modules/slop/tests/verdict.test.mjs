import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSlopVerdict } from '../dist/api/slop-service.js';

const rules = [
  {
    id: 'builtin-tests',
    workspaceId: null,
    name: 'Test evidence',
    description: '',
    instructions: '',
    builtin: true,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  },
];

test('quality and AI authorship stay independent in a parsed verdict', () => {
  const verdict = parseSlopVerdict(
    JSON.stringify({
      aiLikelihood: 92,
      confidence: 'high',
      qualityClass: 'valuable',
      valueScore: 90,
      evidenceScore: 88,
      technicalRisk: 'low',
      testEvidence: 'strong',
      reviewability: 'ready',
      decisionFactors: [
        { dimension: 'tests', effect: 'positive', observation: 'src/x.test.ts asserts the changed error path.' },
      ],
      summary: 'Likely AI-assisted, but focused and well evidenced.',
      signals: [{ ruleId: 'builtin-tests', observation: 'AI trailer disclosed.', strength: 'weak' }],
      recommendedAction: 'none',
      reviewerHints: [],
      draftComment: '',
    }),
    rules,
  );
  assert.equal(verdict.aiLikelihood, 92);
  assert.equal(verdict.qualityClass, 'valuable');
  assert.equal(verdict.signals[0].ruleName, 'Test evidence');
});

test('a verdict without the evidence axes is rejected instead of guessed', () => {
  assert.throws(() =>
    parseSlopVerdict(
      JSON.stringify({
        aiLikelihood: 50,
        confidence: 'low',
        summary: 'old shape',
        signals: [],
        recommendedAction: 'comment',
        reviewerHints: [],
        draftComment: '',
      }),
      rules,
    ),
  );
});

test('a quality decision requires bounded, explicit evidence factors', () => {
  const base = {
    aiLikelihood: 70,
    confidence: 'medium',
    qualityClass: 'needs_evidence',
    valueScore: 55,
    evidenceScore: 20,
    technicalRisk: 'medium',
    testEvidence: 'weak',
    reviewability: 'ready',
    decisionFactors: [{ dimension: 'tests', effect: 'negative', observation: 'No regression test covers the change.' }],
    summary: 'The idea may be useful, but evidence is missing.',
    signals: [],
    recommendedAction: 'request_changes',
    reviewerHints: ['Ask for a focused regression test.'],
    draftComment: 'Please add evidence for the changed behavior.',
  };
  assert.equal(parseSlopVerdict(JSON.stringify(base), rules).decisionFactors.length, 1);
  assert.throws(() => parseSlopVerdict(JSON.stringify({ ...base, decisionFactors: [] }), rules));
  assert.throws(() =>
    parseSlopVerdict(
      JSON.stringify({
        ...base,
        decisionFactors: [{ dimension: 'tests', effect: 'negative', observation: 'x'.repeat(1001) }],
      }),
      rules,
    ),
  );
});
