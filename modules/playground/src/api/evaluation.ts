import { extractModelJson } from '@moxxy/companion-sdk/agents';
import type {
  PlaygroundEvaluationCheck,
  PlaygroundEvaluationExpectation,
  PlaygroundJsonPrimitive,
} from '../contract/index.js';

export interface PlaygroundEvaluationMetrics {
  readonly durationMs: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

/** Deterministic post-run scoring. The model never decides whether it passed. */
export function evaluatePlaygroundResponse(
  message: string | null,
  expectation: PlaygroundEvaluationExpectation,
  metrics: PlaygroundEvaluationMetrics,
  productionParsed?: unknown,
): { readonly passed: boolean; readonly checks: ReadonlyArray<PlaygroundEvaluationCheck> } {
  const checks: PlaygroundEvaluationCheck[] = [];
  const answer = message ?? '';
  const folded = answer.toLocaleLowerCase();
  checks.push({
    kind: 'response',
    label: 'Final response produced',
    passed: message !== null && answer.trim().length > 0,
    detail: message !== null && answer.trim().length > 0 ? `${answer.length.toLocaleString()} characters` : 'No final assistant response.',
  });

  let json: unknown = null;
  let jsonAvailable = false;
  if (expectation.responseFormat === 'json') {
    try {
      json = productionParsed ?? extractModelJson(answer);
      jsonAvailable = true;
      checks.push({
        kind: 'format',
        label: 'Parseable JSON response',
        passed: true,
        detail: productionParsed === undefined
          ? 'Production-tolerant JSON extraction succeeded.'
          : 'Exact production parser returned structured output.',
      });
    } catch (err) {
      checks.push({
        kind: 'format',
        label: 'Parseable JSON response',
        passed: false,
        detail: compactError(err),
      });
    }
  }

  for (const phrase of expectation.requiredPhrases) {
    const passed = folded.includes(phrase.toLocaleLowerCase());
    checks.push({
      kind: 'required_phrase',
      label: `Must mention: ${phrase}`,
      passed,
      detail: passed ? 'Required evidence is present.' : 'Required evidence is missing.',
    });
  }
  for (const phrase of expectation.forbiddenPhrases) {
    const passed = !folded.includes(phrase.toLocaleLowerCase());
    checks.push({
      kind: 'forbidden_phrase',
      label: `Must not claim: ${phrase}`,
      passed,
      detail: passed ? 'Unsupported or unsafe claim is absent.' : 'Forbidden claim is present.',
    });
  }

  for (const path of expectation.requiredJsonPaths) {
    const found = jsonAvailable ? valueAtPath(json, path) : { found: false, value: undefined };
    checks.push({
      kind: 'json_path',
      label: `JSON path exists: ${path}`,
      passed: found.found,
      detail: found.found ? `Observed ${formatValue(found.value)}.` : 'Path is missing or JSON could not be parsed.',
    });
  }
  for (const [path, expected] of Object.entries(expectation.expectedJson)) {
    const found = jsonAvailable ? valueAtPath(json, path) : { found: false, value: undefined };
    const allowed = Array.isArray(expected) ? expected : [expected];
    const passed = found.found && allowed.some((candidate) => Object.is(candidate, found.value));
    checks.push({
      kind: 'json_value',
      label: `JSON value: ${path}`,
      passed,
      detail: passed
        ? `Observed allowed value ${formatValue(found.value)}.`
        : `Expected ${allowed.map(formatValue).join(' or ')}; observed ${found.found ? formatValue(found.value) : 'missing'}.`,
    });
  }

  addCeiling(checks, 'duration', 'Wall time', metrics.durationMs, expectation.maxDurationMs, 'ms');
  addCeiling(checks, 'input_tokens', 'Input tokens', metrics.inputTokens, expectation.maxInputTokens, 'tokens');
  addCeiling(checks, 'output_tokens', 'Output tokens', metrics.outputTokens, expectation.maxOutputTokens, 'tokens');

  return { passed: checks.every((check) => check.passed), checks };
}

function valueAtPath(root: unknown, path: string): { readonly found: boolean; readonly value: unknown } {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      const index = Number(segment);
      if (index >= current.length) return { found: false, value: undefined };
      current = current[index];
      continue;
    }
    if (typeof current !== 'object' || current === null || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return { found: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

function addCeiling(
  checks: PlaygroundEvaluationCheck[],
  kind: 'duration' | 'input_tokens' | 'output_tokens',
  label: string,
  actual: number | null,
  ceiling: number | null,
  unit: string,
): void {
  if (ceiling === null) return;
  const passed = actual !== null && actual <= ceiling;
  checks.push({
    kind,
    label: `${label} ≤ ${ceiling.toLocaleString()} ${unit}`,
    passed,
    detail:
      actual === null
        ? `${label} was not reported; the ceiling cannot be proven.`
        : `${actual.toLocaleString()} ${unit} observed.`,
  });
}

function formatValue(value: unknown): string {
  if (value === undefined) return 'missing';
  const json = JSON.stringify(value as PlaygroundJsonPrimitive);
  return (json ?? String(value)).slice(0, 160);
}

function compactError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, ' ').slice(0, 300) || 'JSON could not be parsed.';
}
