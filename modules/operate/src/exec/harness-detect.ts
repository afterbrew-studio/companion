import { detectClaudeCode, type ClaudeCodeCli } from './claude-code.js';
import { detectCodexCli, type CodexCli } from './codex.js';
import { detectMoxxyCli, MIN_MOXXY_VERSION, type MoxxyCli } from './cli.js';
import { configuredProviderNames } from './home.js';

/**
 * What this machine could actually run work through, read off disk.
 *
 * Three states, because two would lie. A harness that is installed but cannot
 * complete a turn (no credentials, a version this daemon is not written
 * against) is not the same as one that is not there: offering the first as a
 * choice produces an instance that looks configured and fails on its first run,
 * and mentioning the second turns a setup step into a catalogue.
 *
 * Probing and judging are separate below. The probes shell out and so depend on
 * what is installed; the judgements are functions of what a probe returned, so
 * every state is reachable from a test on any machine.
 */
export type HarnessState =
  /** On PATH, and its own check passes. */
  | 'ready'
  /** On PATH, and something about it will fail. `fix` says what to do. */
  | 'installed'
  /** Not on PATH. Never offered and never mentioned. */
  | 'absent';

export interface HarnessDetection {
  readonly id: string;
  readonly state: HarnessState;
  /** What is wrong; null when nothing is. */
  readonly detail: string | null;
  /** The one command that fixes it, where a command can. */
  readonly fix: string | null;
}

/**
 * Every harness this build implements, in the order a chooser should show them.
 * moxxy leads because it is the only one with the full capability set and stays
 * the default.
 */
export async function detectHarnesses(moxxyHome: string): Promise<readonly HarnessDetection[]> {
  const [moxxy, claude, codex] = await Promise.all([
    detectMoxxyCli(moxxyHome),
    detectClaudeCode(),
    detectCodexCli(),
  ]);
  return [moxxyState(moxxy, configuredProviderNames()), claudeState(claude), codexState(codex)];
}

/**
 * moxxy runs on the operator's own provider credentials, so a home with none is
 * installed and unusable in exactly the way the middle state exists to report:
 * it starts, and every turn has nothing to run on.
 */
export function moxxyState(cli: MoxxyCli | null, providers: readonly string[]): HarnessDetection {
  if (!cli) return { id: 'moxxy', state: 'absent', detail: null, fix: null };
  if (!cli.compatible) {
    return {
      id: 'moxxy',
      state: 'installed',
      detail: `Version ${cli.version} is older than the ${MIN_MOXXY_VERSION} this daemon is written against.`,
      fix: 'npm i -g @moxxy/cli@latest',
    };
  }
  if (providers.length === 0) {
    return {
      id: 'moxxy',
      state: 'installed',
      detail: 'No model provider is configured for it, so a turn would have nothing to run on.',
      fix: 'moxxy provision',
    };
  }
  return { id: 'moxxy', state: 'ready', detail: null, fix: null };
}

/** Codex brings its own sign-in too, so the same one check settles it. */
export function codexState(cli: CodexCli | null): HarnessDetection {
  if (!cli) return { id: 'codex', state: 'absent', detail: null, fix: null };
  if (!cli.loggedIn) {
    return {
      id: 'codex',
      state: 'installed',
      detail: 'It is installed but not signed in, so every turn would be refused.',
      fix: 'codex login',
    };
  }
  return { id: 'codex', state: 'ready', detail: null, fix: null };
}

/** Claude Code brings its own sign-in, so being signed out is its whole check. */
export function claudeState(cli: ClaudeCodeCli | null): HarnessDetection {
  if (!cli) return { id: 'claude-code', state: 'absent', detail: null, fix: null };
  if (!cli.loggedIn) {
    return {
      id: 'claude-code',
      state: 'installed',
      detail: 'It is installed but not signed in, so every turn would be refused.',
      fix: 'claude auth login',
    };
  }
  return { id: 'claude-code', state: 'ready', detail: null, fix: null };
}
