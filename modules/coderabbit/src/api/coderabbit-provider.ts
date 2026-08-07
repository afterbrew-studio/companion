import type {
  IntegrationCommandResult,
  IntegrationCommandRunner,
  IntegrationProviderAdapter,
  IntegrationReviewFinding,
  IntegrationReviewResult,
} from '@companion/module-integrations/provider';
import { IntegrationUnavailableError } from '@companion/module-integrations/provider';

/** In preference order; the machine runs the first of them it has. */
const BINARIES = ['cr', 'coderabbit'] as const;
const REVIEW_TIMEOUT_MS = 45 * 60_000;
const PROBE_TIMEOUT_MS = 15_000;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 512 * 1024;

interface AgentEvent {
  readonly type?: unknown;
  readonly severity?: unknown;
  readonly fileName?: unknown;
  readonly line?: unknown;
  readonly lineNumber?: unknown;
  readonly codegenInstructions?: unknown;
  readonly comment?: unknown;
  readonly suggestions?: unknown;
  readonly status?: unknown;
  readonly message?: unknown;
  readonly error?: unknown;
  readonly findings?: unknown;
}

export const coderabbitProvider: IntegrationProviderAdapter = {
  descriptor: {
    id: 'coderabbit.cli',
    moduleId: 'coderabbit',
    vendor: 'CodeRabbit',
    title: 'CodeRabbit CLI',
    description: 'Run CodeRabbit against the checked-out PR and bring structured findings back as a Companion draft.',
    category: 'review',
    capabilities: ['code-review'],
    scopes: ['instance', 'workspace'],
    connectionMode: 'required',
    execution: 'local',
    requires: [...BINARIES],
    fields: [],
    docsUrl: 'https://docs.coderabbit.ai/cli/reference',
    setup:
      'Install the cr CLI on any machine Companion can run work on (the daemon host or a registered runner such as your own laptop) and authenticate that machine\u2019s user with cr auth login. Companion runs the review where the CLI is, and never accepts a custom executable or puts an API key in process arguments.',
  },

  probe: async (_connection, context) => {
    // Nothing to probe means no machine Companion can reach has the CLI, not
    // that CodeRabbit is broken. Naming where it would have to be installed is
    // the actionable half of that answer.
    if (!context?.exec) {
      return {
        status: 'unavailable',
        message:
          'No machine Companion can reach has the CodeRabbit CLI. Install cr on the Companion host or on a registered runner (your own laptop counts) and sign in there.',
        checkedAt: Date.now(),
      };
    }
    try {
      const result = await context.exec.run(['auth', 'status', '--agent'], { timeoutMs: PROBE_TIMEOUT_MS });
      if (result.missing) {
        return {
          status: 'unavailable',
          message: `${context.exec.machine} no longer has the CodeRabbit CLI on PATH`,
          checkedAt: Date.now(),
        };
      }
      if (result.code !== 0) {
        return {
          status: 'unavailable',
          message:
            `${context.exec.machine}: ${result.stderr.trim() || result.stdout.trim() || 'CodeRabbit is not authenticated'}`,
          checkedAt: Date.now(),
        };
      }
      return {
        status: 'ready',
        message: `${result.binary} is installed and authenticated on ${context.exec.machine}`,
        checkedAt: Date.now(),
      };
    } catch (error) {
      return { status: 'unavailable', message: messageOf(error), checkedAt: Date.now() };
    }
  },

  review: async (_connection, request) => {
    if (!request.cwd) throw new IntegrationUnavailableError('CodeRabbit needs a pull-request worktree');
    // The worktree is on whichever machine has the CLI, which may not be the
    // one this code runs on. Spawning here would run the tool where neither the
    // checkout nor the sign-in is.
    if (!request.exec) throw new IntegrationUnavailableError('No machine with the CodeRabbit CLI is available');
    request.progress(`Starting CodeRabbit CLI review on ${request.exec.machine}`);
    const result: IntegrationCommandResult = await run(request.exec, request);
    if (result.missing) {
      throw new IntegrationUnavailableError(
        `${request.exec.machine} does not have the CodeRabbit CLI (\`cr\` or \`coderabbit\` must be on PATH)`,
      );
    }
    if (result.timedOut) throw new Error('CodeRabbit exceeded its 45 minute limit');
    const parsed = parseAgentOutput(result.stdout);
    if (result.code !== 0) {
      const message = parsed.error ?? (result.stderr.trim() || `CodeRabbit exited with ${result.code}`);
      if (/auth|credential|log\s*in|sign(?:ed)?\s*in|network|connect/i.test(message)) {
        throw new IntegrationUnavailableError(message);
      }
      throw new Error(message);
    }
    if (parsed.error) throw new Error(parsed.error);
    if (parsed.skipped) return { kind: 'skipped', summary: parsed.summary ?? 'CodeRabbit found no changes to review' };
    // A successful process without the documented terminal event means the
    // provider protocol changed or produced malformed output. That is a real
    // review failure, not availability loss eligible for a silent fallback.
    if (!parsed.complete) throw new Error('CodeRabbit exited without a complete review event');
    return {
      kind: 'draft',
      summary: parsed.summary ?? summaryFor(parsed.findings),
      reviewBody: parsed.summary ?? summaryFor(parsed.findings),
      findings: parsed.findings,
      coverage: 'complete',
    } satisfies IntegrationReviewResult;
  },
};

/**
 * `cr review` against the checked-out pull request.
 *
 * `--dir` is the worktree as that machine sees it: for a remote runner it is a
 * path on the runner's disk, which is exactly the path the review request
 * carries and never one this process could resolve.
 */
function run(
  exec: IntegrationCommandRunner,
  request: { cwd: string | null; baseRef: string; signal: AbortSignal; progress: (message: string) => void },
): Promise<IntegrationCommandResult> {
  return exec.run(['review', '--agent', '--committed', '--base', request.baseRef, '--dir', request.cwd ?? '.'], {
    timeoutMs: REVIEW_TIMEOUT_MS,
    signal: request.signal,
    maxStdout: MAX_STDOUT_BYTES,
    maxStderr: MAX_STDERR_BYTES,
    onLine: (line) => {
      const event = parseEvent(line);
      if (event?.type === 'status' && typeof event.message === 'string') request.progress(event.message);
    },
  });
}

export function parseAgentOutput(output: string): {
  readonly findings: IntegrationReviewFinding[];
  readonly complete: boolean;
  readonly skipped: boolean;
  readonly summary: string | null;
  readonly error: string | null;
} {
  const findings: IntegrationReviewFinding[] = [];
  let complete = false;
  let skipped = false;
  let summary: string | null = null;
  let error: string | null = null;
  for (const line of output.split(/\r?\n/)) {
    const event = parseEvent(line);
    if (!event) continue;
    if (event.type === 'finding') findings.push(toFinding(event));
    if (event.type === 'error') error = stringValue(event.message) || stringValue(event.error) || 'CodeRabbit review failed';
    if (event.type === 'complete') {
      complete = true;
      skipped = event.status === 'review_skipped';
      summary = stringValue(event.message) || summary;
    }
  }
  return { findings, complete, skipped, summary, error };
}

function parseEvent(line: string): AgentEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? (parsed as AgentEvent) : null;
  } catch {
    return null;
  }
}

function toFinding(event: AgentEvent): IntegrationReviewFinding {
  const comment = stringValue(event.comment);
  const instructions = stringValue(event.codegenInstructions);
  const reason = instructions || comment || 'CodeRabbit reported a finding.';
  const suggestion = suggestionsText(event.suggestions);
  const file = stringValue(event.fileName) || null;
  return {
    severity: severityOf(event.severity),
    title: titleOf(comment || pointOf(instructions) || reason, file),
    file,
    line: positiveInteger(event.lineNumber) ?? positiveInteger(event.line),
    reason: reason.slice(0, 4_000),
    impact: `Reported by CodeRabbit${file ? ` in ${file}` : ''}.`,
    suggestion: suggestion.slice(0, 4_000),
    confidence: 0.8,
  };
}

function severityOf(value: unknown): IntegrationReviewFinding['severity'] {
  switch (value) {
    case 'critical': return 'blocker';
    case 'major': return 'major';
    case 'minor': return 'minor';
    case 'trivial':
    case 'info':
    default: return 'nit';
  }
}

/**
 * The point inside CodeRabbit's codegen instructions.
 *
 * They open with a fixed preamble addressed to whatever agent will apply them
 * ("Verify each finding against current code…"), then a paragraph that locates
 * the point ("In @file around lines 12 - 20, …"). Titling from the first
 * sentence gave every finding in a review the same title, which is how a review
 * of six files arrived as six copies of one line.
 */
function pointOf(instructions: string): string {
  const last = instructions.split(/\n\s*\n/).pop()?.trim() ?? '';
  return last.replace(/^in\s+@?\S+\s+around\s+lines?\s+[\d\s,–-]+,\s*/i, '').trim();
}

function titleOf(reason: string, file: string | null): string {
  const first = reason.split(/\n|(?<=[.!?])\s/)[0]?.replace(/^[-*#\s]+/, '').trim();
  if (first) return first.slice(0, 180);
  return file ? `Review finding in ${file}` : 'CodeRabbit review finding';
}

function suggestionsText(value: unknown): string {
  if (!Array.isArray(value)) return stringValue(value);
  return value
    .map((entry) => typeof entry === 'string' ? entry : JSON.stringify(entry))
    .filter(Boolean)
    .join('\n\n');
}

function summaryFor(findings: readonly IntegrationReviewFinding[]): string {
  if (findings.length === 0) return 'CodeRabbit completed the review without reportable findings.';
  const serious = findings.filter((finding) => finding.severity === 'blocker' || finding.severity === 'major').length;
  return `CodeRabbit completed the review with ${findings.length} finding${findings.length === 1 ? '' : 's'}${serious ? `, including ${serious} serious` : ''}.`;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function messageOf(error: unknown): string {
  return String(error instanceof Error ? error.message : error).slice(0, 1_000);
}
