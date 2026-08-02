import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSlopEvaluationPrompt,
  parseSlopEvaluationResponse,
  SLOP_ASSESSMENT_PROMPT_VERSION,
} from '../dist/api/slop-service.js';

test('contribution evaluation reuses the production quality/provenance contract', () => {
  const prompt = buildSlopEvaluationPrompt({
    pr: {
      number: 1,
      title: 'Focused fix',
      body: 'AI-assisted and reviewed.',
      headRef: 'fix/cache',
      baseRef: 'main',
      draft: false,
      author: 'author',
      labels: [],
    },
    diffEvidence: 'diff --git a/cache.ts b/cache.ts\n+if (!entry) return null;',
    evidenceComplete: true,
  });
  assert.equal(SLOP_ASSESSMENT_PROMPT_VERSION, 1);
  assert.match(prompt, /Do not turn authorship into quality/);
  assert.match(prompt, /<untrusted_diff>/);

  const verdict = parseSlopEvaluationResponse(JSON.stringify({
    aiLikelihood: 90,
    confidence: 'high',
    qualityClass: 'valuable',
    valueScore: 85,
    evidenceScore: 90,
    technicalRisk: 'low',
    testEvidence: 'strong',
    reviewability: 'ready',
    decisionFactors: [{ dimension: 'tests', effect: 'positive', observation: 'cache.test.ts covers absence' }],
    summary: 'A focused and tested fix.',
    signals: [],
    recommendedAction: 'none',
    reviewerHints: [],
    draftComment: '',
  }));
  assert.equal(verdict.aiLikelihood, 90);
  assert.equal(verdict.qualityClass, 'valuable');
  assert.equal(verdict.recommendedAction, 'none');
});
