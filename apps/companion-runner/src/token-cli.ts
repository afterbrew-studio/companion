import { loadRunnerConfig } from './config.js';
import { RunnerTokens, type RunnerToken } from './tokens.js';

/**
 * `companion-runner token …`: issue and revoke the credentials a controlling
 * Companion presents, while the runner keeps running.
 *
 * Rotation without downtime is the whole point of the shape: issue a second
 * token, paste it into Companion, then revoke the first. The agent re-reads the
 * store whenever it changes, so neither half needs a restart of a machine that
 * may be in the middle of somebody's work.
 */
export function runTokenCommand(argv: readonly string[]): number {
  const config = loadRunnerConfig();
  const tokens = new RunnerTokens(config.home, config.tokenEnv);
  const [sub, ...rest] = argv;
  try {
    switch (sub ?? 'list') {
      case 'list':
        return list(tokens, config.tokenEnv !== null);
      case 'new':
      case 'add':
        return issue(tokens, rest.join(' '));
      case 'revoke':
        return revoke(tokens, rest[0]);
      case 'rotate':
        return rotate(tokens, rest.join(' '));
      case 'prune': {
        const removed = tokens.prune();
        out(`removed ${removed} revoked token${removed === 1 ? '' : 's'}\n`);
        return 0;
      }
      default:
        err(`unknown token command: ${sub}\n\n${TOKEN_HELP}`);
        return 2;
    }
  } finally {
    tokens.close();
  }
}

export const TOKEN_HELP = `companion-runner token: credentials Companion presents to this machine

  token list             Show every token (never the secrets).
  token new [label]      Issue one and print it once.
  token revoke <id>      Revoke one by id or exact label.
  token rotate [label]   Issue one and revoke every other token.
  token prune            Forget revoked entries.

Rotate without downtime: "token new", paste it into Companion, then
"token revoke <old-id>". A running runner picks both up immediately.
`;

function list(tokens: RunnerTokens, hasEnv: boolean): number {
  if (hasEnv) out('  COMPANION_RUNNER_TOKEN is set: always valid, and not stored here.\n');
  const all = tokens.list();
  if (all.length === 0) {
    out(hasEnv ? '  No stored tokens.\n' : '  No tokens. Issue one with: companion-runner token new\n');
    return 0;
  }
  out(`\n  ${'ID'.padEnd(14)}${'LABEL'.padEnd(32)}${'CREATED'.padEnd(14)}${'LAST USED'.padEnd(14)}STATE\n`);
  for (const token of all) {
    out(
      `  ${token.id.padEnd(14)}${token.label.slice(0, 30).padEnd(32)}` +
        `${ago(token.createdAt).padEnd(14)}${(token.lastUsedAt ? ago(token.lastUsedAt) : 'never').padEnd(14)}` +
        `${token.revokedAt === null ? 'active' : `revoked ${ago(token.revokedAt)}`}\n`,
    );
  }
  out('\n');
  return 0;
}

function issue(tokens: RunnerTokens, label: string): number {
  const { token, secret } = tokens.issue(label || 'runner token');
  printSecret(token, secret);
  return 0;
}

function revoke(tokens: RunnerTokens, idOrLabel: string | undefined): number {
  if (!idOrLabel) {
    err('usage: companion-runner token revoke <id|label>\n');
    return 2;
  }
  const revoked = tokens.revoke(idOrLabel);
  if (!revoked) {
    err(`no active token matches "${idOrLabel}"\n`);
    return 1;
  }
  out(`revoked ${revoked.id} (${revoked.label}). A Companion still using it now gets 401.\n`);
  return 0;
}

function rotate(tokens: RunnerTokens, label: string): number {
  const { token, secret } = tokens.issue(label || 'rotated');
  const revoked = tokens.revokeOthers(token.id);
  printSecret(token, secret);
  out(
    revoked === 0
      ? '  Nothing else was active.\n\n'
      : `  Revoked ${revoked} older token${revoked === 1 ? '' : 's'}. Update Companion now, or it will get 401.\n\n`,
  );
  return 0;
}

function printSecret(token: RunnerToken, secret: string): void {
  out(`\n  ${token.id}  ${token.label}\n\n    ${secret}\n\n`);
  out('  Shown once: only its hash is stored. Paste it into Companion → Runners.\n\n');
}

function ago(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

function out(text: string): void {
  process.stdout.write(text);
}

function err(text: string): void {
  process.stderr.write(text);
}
