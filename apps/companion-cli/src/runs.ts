import { apiClient } from './client.js';

/**
 * The fields this command prints, declared locally.
 *
 * The CLI depends on the framework and nothing else: importing a feature module's
 * contract would tie the published package to a module that may not even be in the
 * build it is talking to. It speaks HTTP, so it only needs the shape of what it
 * reads, and an unknown extra field is simply not printed.
 */
interface RunVerification {
  readonly status: 'running' | 'passed' | 'failed' | 'unavailable';
  readonly command: string;
  readonly exitCode: number | null;
  readonly output: string;
  readonly timedOut: boolean;
}

interface RunRecord {
  readonly id: string;
  readonly status: string;
  readonly title: string;
  readonly repo: string | null;
  readonly branch: string | null;
  readonly prUrl: string | null;
  readonly outcome: string | null;
  readonly verification: RunVerification | null;
}

export const RUN_HELP = `Usage: companion run <command> [options]

  list [--all]               Runs awaiting you (add --all for every run)
  show <id>                  One run: status, verification, outcome
  diff <id>                  The diff a run produced, on stdout
  approve <id> [--title t]   Push the branch and open a pull request
  discard <id> [--yes]       Throw the run and its worktree away

Options:
  --all                      list: include finished runs, not just actionable ones
  --yes                      Skip the discard confirmation (required when piped)
  --json                     Machine-readable output
  --home <path>              Data directory (default: COMPANION_HOME or ~/.companion)
  --host <host> --port <n>   Address of the running daemon

Companion must be running. Commands authenticate with the token in
<home>/cli-token, which the daemon mints at boot.

\`diff\` writes only the diff to stdout, so it pipes:
  companion run diff run-abc123 | delta
`;

export interface RunCommand {
  readonly action: 'list' | 'show' | 'diff' | 'approve' | 'discard';
  readonly id?: string;
  readonly all: boolean;
  readonly yes: boolean;
  readonly json: boolean;
  readonly title?: string;
}

export function parseRunCommand(argv: readonly string[]): RunCommand {
  const [action, ...rest] = argv;
  if (action !== 'list' && action !== 'show' && action !== 'diff' && action !== 'approve' && action !== 'discard') {
    throw new Error(`Unknown run command: ${String(action)}\n\n${RUN_HELP}`);
  }
  let id: string | undefined;
  let all = false;
  let yes = false;
  let json = false;
  let title: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === '--all') all = true;
    else if (arg === '--yes' || arg === '-y') yes = true;
    else if (arg === '--json') json = true;
    else if (arg === '--title') {
      const value = rest[++i];
      if (value === undefined) throw new Error('--title needs a value');
      title = value;
    } else if (!arg.startsWith('-') && id === undefined) id = arg;
    else throw new Error(`Unknown argument: ${arg}\n\n${RUN_HELP}`);
  }
  if (action !== 'list' && !id) throw new Error(`${action} needs a run id\n\n${RUN_HELP}`);
  return { action, id, all, yes, json, title };
}

/**
 * The statuses a person can actually act on.
 *
 * `list` defaults to these because the interesting question in a terminal is
 * "what is waiting for me", and a bare list of every run this instance ever
 * executed answers a different one. `--all` is there for when it does not.
 */
const ACTIONABLE = new Set(['review', 'queued', 'provisioning', 'running', 'idle']);

function verificationLine(v: RunVerification | null): string | null {
  if (!v) return null;
  switch (v.status) {
    case 'running':
      return `  verification: running (${v.command})`;
    case 'unavailable':
      return `  verification: not checked`;
    case 'passed':
      return `  verification: passed (${v.command})`;
    case 'failed':
      return `  verification: FAILED (${v.command}, ${v.timedOut ? 'timed out' : `exit ${v.exitCode ?? 'signal'}`})`;
    default:
      // A status a newer daemon added: say nothing rather than guess at it.
      return null;
  }
}

export async function runRunCommand(command: RunCommand, baseUrl: string): Promise<void> {
  const api = apiClient(baseUrl);
  const out = (text: string): void => {
    process.stdout.write(`${text}\n`);
  };

  if (command.action === 'list') {
    const { runs } = await api<{ runs: RunRecord[] }>('GET', '/api/runs');
    const shown = command.all ? runs : runs.filter((r) => ACTIONABLE.has(r.status));
    if (command.json) {
      out(JSON.stringify(shown, null, 2));
      return;
    }
    if (shown.length === 0) {
      out(command.all ? 'No runs yet.' : 'Nothing waiting on you. Add --all to see finished runs.');
      return;
    }
    for (const run of shown) {
      const failed = run.verification?.status === 'failed' ? '  [verification failed]' : '';
      out(`${run.id}  ${run.status.padEnd(12)} ${run.repo ?? '-'}  ${run.title.slice(0, 60)}${failed}`);
    }
    return;
  }

  if (command.action === 'show') {
    const { run } = await api<{ run: RunRecord }>('GET', `/api/runs/${command.id}`);
    if (command.json) {
      out(JSON.stringify(run, null, 2));
      return;
    }
    out(`${run.id}  ${run.status}`);
    out(`  ${run.title}`);
    if (run.repo) out(`  repo: ${run.repo}${run.branch ? ` (${run.branch})` : ''}`);
    const verification = verificationLine(run.verification);
    if (verification) out(verification);
    // The output only when it says something, and only when it is bad news:
    // nobody reads a passing build's log.
    if (run.verification?.status === 'failed' && run.verification.output) out(`\n${run.verification.output}`);
    if (run.outcome) out(`  outcome: ${run.outcome}`);
    if (run.prUrl) out(`  pr: ${run.prUrl}`);
    return;
  }

  if (command.action === 'diff') {
    const { diff } = await api<{ diff: string }>('GET', `/api/runs/${command.id}/diff`);
    // Nothing but the diff, so this pipes into a pager or a review tool.
    if (diff.trim()) process.stdout.write(diff.endsWith('\n') ? diff : `${diff}\n`);
    else process.stderr.write('This run produced no changes.\n');
    return;
  }

  if (command.action === 'approve') {
    // Say it out loud rather than refusing: the reviewer may well have a reason,
    // and a CLI that silently blocks is worse than one that warns.
    const { run } = await api<{ run: RunRecord }>('GET', `/api/runs/${command.id}`);
    if (run.verification?.status === 'failed') {
      process.stderr.write(`Warning: verification failed for this run (${run.verification.command}).\n`);
    }
    const result = await api<{ prUrl: string }>(
      'POST',
      `/api/runs/${command.id}/approve-pr`,
      command.title === undefined ? {} : { title: command.title },
    );
    out(command.json ? JSON.stringify(result, null, 2) : result.prUrl);
    return;
  }

  if (!command.yes) {
    if (!process.stdin.isTTY) {
      throw new Error('discard is destructive: pass --yes when there is no terminal to confirm at.');
    }
    process.stdout.write(`Discard ${command.id} and its worktree? The branch is lost. [y/N] `);
    const answer = await new Promise<string>((resolve) => {
      process.stdin.setEncoding('utf8');
      process.stdin.once('data', (d) => resolve(String(d).trim().toLowerCase()));
    });
    if (answer !== 'y' && answer !== 'yes') {
      out('Left alone.');
      return;
    }
  }
  await api('POST', `/api/runs/${command.id}/discard`);
  out(`Discarded ${command.id}.`);
}
