import { spawn } from 'node:child_process';
import type {
  IntegrationProviderAdapter,
  IntegrationReviewFinding,
  IntegrationReviewResult,
} from '@companion/module-integrations/provider';
import { IntegrationUnavailableError } from '@companion/module-integrations/provider';

const BINARIES = ['cr', 'coderabbit'] as const;
const REVIEW_TIMEOUT_MS = 45 * 60_000;
const PROBE_TIMEOUT_MS = 15_000;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 512 * 1024;
const SAFE_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
] as const;

interface CommandResult {
  readonly binary: string;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

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
    fields: [],
    docsUrl: 'https://docs.coderabbit.ai/cli/reference',
    setup:
      'Install the cr CLI on the Companion host and authenticate the daemon user with cr auth login. Companion never accepts a custom executable or puts an API key in process arguments.',
  },

  probe: async () => {
    try {
      const result = await runFirstAvailable(['auth', 'status', '--agent'], {
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      if (result.code !== 0) {
        return {
          status: 'unavailable',
          message: result.stderr.trim() || result.stdout.trim() || 'CodeRabbit is not authenticated',
          checkedAt: Date.now(),
        };
      }
      return {
        status: 'ready',
        message: `${result.binary} is installed and authenticated`,
        checkedAt: Date.now(),
      };
    } catch (error) {
      return { status: 'unavailable', message: messageOf(error), checkedAt: Date.now() };
    }
  },

  review: async (_connection, request) => {
    if (!request.cwd) throw new IntegrationUnavailableError('CodeRabbit needs a local pull-request worktree');
    request.progress('Starting CodeRabbit CLI review');
    let result: CommandResult;
    try {
      result = await runFirstAvailable(
        ['review', '--agent', '--committed', '--base', request.baseRef, '--dir', request.cwd],
        {
          cwd: request.cwd,
          timeoutMs: REVIEW_TIMEOUT_MS,
          signal: request.signal,
          onLine: (line) => {
            const event = parseEvent(line);
            if (event?.type === 'status' && typeof event.message === 'string') request.progress(event.message);
          },
        },
      );
    } catch (error) {
      if (request.signal.aborted) throw error;
      if (error instanceof IntegrationUnavailableError) throw error;
      // A provider that started and then timed out, overflowed its bounded
      // output, or crashed produced a real review failure. Ordered fallback is
      // reserved for absence/auth/network, never for hiding tool defects.
      throw error;
    }
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
  const reason = stringValue(event.codegenInstructions) || stringValue(event.comment) || 'CodeRabbit reported a finding.';
  const suggestion = suggestionsText(event.suggestions);
  const file = stringValue(event.fileName) || null;
  return {
    severity: severityOf(event.severity),
    title: titleOf(reason, file),
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

async function runFirstAvailable(
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
    readonly onLine?: (line: string) => void;
  },
): Promise<CommandResult> {
  let last: unknown = null;
  for (const binary of BINARIES) {
    try {
      return await run(binary, args, options);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      last = error;
    }
  }
  throw new IntegrationUnavailableError(
    last ? 'CodeRabbit CLI was not found (`cr` or `coderabbit` must be on PATH)' : 'CodeRabbit CLI is unavailable',
  );
}

function run(
  binary: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
    readonly onLine?: (line: string) => void;
  },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error('CodeRabbit review cancelled'));
      return;
    }
    const child = spawn(binary, args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      shell: false,
      // A CLI may start helpers. Give the review its own process group so
      // cancellation cannot leave credential-bearing grandchildren running.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      // A provider CLI is a separate trust boundary. It needs the daemon
      // user's CLI config and network settings, not unrelated Companion,
      // GitHub or model-provider credentials from the daemon environment.
      env: codeRabbitEnvironment(),
    });
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let pending = '';
    let settled = false;
    let terminalError: Error | null = null;
    let forceKill: NodeJS.Timeout | null = null;
    const stop = (): void => {
      signalProcessTree(child, 'SIGTERM');
      forceKill ??= setTimeout(() => signalProcessTree(child, 'SIGKILL'), 5_000);
      forceKill.unref();
    };
    const finish = (work: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      work();
    };
    const terminate = (error: Error): void => {
      if (terminalError) return;
      terminalError = error;
      stop();
    };
    const abort = (): void => terminate(new Error('CodeRabbit review cancelled'));
    const timer = setTimeout(() => {
      terminate(new Error('CodeRabbit review exceeded its 45 minute limit'));
    }, options.timeoutMs);
    timer.unref();

    child.once('error', (error) => finish(() => reject(error)));
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        terminate(new Error('CodeRabbit output exceeded the 8 MiB safety limit'));
        return;
      }
      const text = chunk.toString('utf8');
      stdout += text;
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) options.onLine?.(line);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= MAX_STDERR_BYTES) return;
      const kept = chunk.subarray(0, MAX_STDERR_BYTES - stderrBytes);
      stderr += kept.toString('utf8');
      stderrBytes += kept.byteLength;
    });
    child.once('close', (code) => {
      if (forceKill) clearTimeout(forceKill);
      finish(() => {
        if (terminalError) reject(terminalError);
        else resolve({ binary, code: code ?? 1, stdout, stderr });
      });
    });
    options.signal?.addEventListener('abort', abort, { once: true });
    // Close the small race between the pre-spawn check and listener setup.
    if (options.signal?.aborted) abort();
  });
}

export function codeRabbitEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function signalProcessTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.pid !== undefined && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group may already be gone; fall back to the direct child below.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Cancellation is idempotent and a process that already exited is done.
  }
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
