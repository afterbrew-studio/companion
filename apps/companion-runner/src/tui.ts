import { networkInterfaces } from 'node:os';
import type { AgentRuntimeHealth } from '@moxxy/companion-types';
import type { CliHarnessSessions } from './harnesses.js';
import type { RunnerConfig } from './config.js';
import type { RunnerTokens } from './tokens.js';
import type { RunnerTunnel } from './tunnel.js';

/**
 * The runner's dashboard.
 *
 * A runner on a server is a log stream; a runner on the machine somebody is
 * working at is a window they leave open, and those want opposite things. What
 * that person needs at a glance is the two facts that make the machine usable,
 * where Companion reaches it and which credential to paste, plus what it was
 * detected as being able to run, because "why is my laptop not offered Claude
 * Code" is answered by a line on this screen rather than by reading a log.
 *
 * Hand-drawn with ANSI escapes and no dependency: a runner is published as one
 * bundled file that has to start on a bare box, and a terminal UI framework is
 * a lot of surface to carry for eight boxes and one keypress handler.
 */

const ESC = '\u001b[';
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const ALT_SCREEN_ON = `${ESC}?1049h`;
const ALT_SCREEN_OFF = `${ESC}?1049l`;
const CLEAR = `${ESC}2J${ESC}H`;

const dim = (s: string): string => `${ESC}2m${s}${ESC}22m`;
const bold = (s: string): string => `${ESC}1m${s}${ESC}22m`;
const green = (s: string): string => `${ESC}32m${s}${ESC}39m`;
const yellow = (s: string): string => `${ESC}33m${s}${ESC}39m`;
const red = (s: string): string => `${ESC}31m${s}${ESC}39m`;
const cyan = (s: string): string => `${ESC}36m${s}${ESC}39m`;

const REFRESH_MS = 2_000;
/** How many log lines the panel keeps; the file on disk keeps everything. */
const LOG_LINES = 8;

export interface DashboardSources {
  readonly config: RunnerConfig;
  readonly tokens: RunnerTokens;
  readonly cli: CliHarnessSessions;
  readonly tunnel: RunnerTunnel | null;
  /** Runs live right now, across every runtime. */
  liveRuns(): number;
  startTunnel(): Promise<string>;
}

export class Dashboard {
  private timer: NodeJS.Timeout | null = null;
  private readonly logLines: string[] = [];
  private notice: string | null = null;
  private noticeAt = 0;
  private runtimes: readonly AgentRuntimeHealth[] = [];
  private stopped = false;

  constructor(private readonly sources: DashboardSources) {}

  /** Take over the terminal. Returns a function that gives it back. */
  start(): () => void {
    process.stdout.write(ALT_SCREEN_ON + HIDE_CURSOR);
    const stdin = process.stdin;
    if (stdin.isTTY) {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');
      stdin.on('data', this.onKey);
    }
    process.stdout.on('resize', this.render);
    this.timer = setInterval(() => void this.tick(), REFRESH_MS);
    void this.tick();
    return () => this.stop();
  }

  /**
   * A log line, mirrored into the panel.
   *
   * The dashboard owns the screen, so anything written straight to stdout would
   * land in the middle of a box. Routing the logger through here is what keeps
   * both: a readable screen and the running commentary the operator came for.
   */
  push(line: string): void {
    this.logLines.push(line);
    while (this.logLines.length > LOG_LINES) this.logLines.shift();
  }

  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    process.stdout.off('resize', this.render);
    if (process.stdin.isTTY) {
      process.stdin.off('data', this.onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
    process.stdout.write(SHOW_CURSOR + ALT_SCREEN_OFF);
  }

  private readonly onKey = (key: string): void => {
    if (key === 'q' || key === '\u0003') {
      process.emit('SIGINT');
      return;
    }
    if (key === 'n') {
      const { token, secret } = this.sources.tokens.issue('issued from the dashboard');
      this.say(`new token ${token.id}: ${secret}`);
      return;
    }
    if (key === 'x') {
      const active = this.sources.tokens.list().filter((t) => t.revokedAt === null);
      const newest = active[active.length - 1];
      if (!newest) {
        this.say('no active token to keep');
        return;
      }
      const revoked = this.sources.tokens.revokeOthers(newest.id);
      this.say(revoked === 0 ? `${newest.id} is already the only active token` : `revoked ${revoked} older token(s)`);
      return;
    }
    if (key === 't') {
      if (!this.sources.tunnel) {
        this.say('no tunnel on this runner');
        return;
      }
      this.say('opening a public address…');
      void this.sources
        .startTunnel()
        .then((url) => this.say(`public address: ${url}`))
        .catch((err) => this.say(`tunnel failed: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    if (key === 'r') {
      this.sources.cli.forgetDetection();
      this.say('re-detecting installed runtimes…');
      void this.tick();
    }
  };

  private say(message: string): void {
    this.notice = message;
    this.noticeAt = Date.now();
    this.render();
  }

  private async tick(): Promise<void> {
    try {
      this.runtimes = await this.sources.cli.runtimes();
    } catch {
      // A failed detection leaves the last answer on screen rather than
      // blanking the panel that explains why a runtime is missing.
    }
    this.render();
  }

  private readonly render = (): void => {
    if (this.stopped) return;
    const { config, tokens, tunnel } = this.sources;
    const width = Math.max(48, Math.min(process.stdout.columns ?? 90, 110));
    const out: string[] = [];
    const rule = (title?: string): void => {
      out.push(title ? dim(`── ${title} ${'─'.repeat(Math.max(0, width - title.length - 4))}`) : dim('─'.repeat(width)));
    };
    const row = (label: string, value: string): void => {
      out.push(`  ${dim(label.padEnd(14))}${value}`);
    };

    out.push('');
    out.push(`  ${bold('companion-runner')}  ${dim(config.home)}`);
    out.push('');

    rule('reachable at');
    const publicUrl = tunnel?.url;
    if (publicUrl) {
      row('public', `${green(publicUrl)}  ${dim('(https, so Companion may send models and secrets)')}`);
    } else if (tunnel) {
      const state = tunnel.status;
      row(
        'public',
        state === 'connecting'
          ? yellow('opening…')
          : state === 'error'
            ? red(tunnel.error ?? 'failed')
            : dim('off, press [t] to publish this machine'),
      );
    }
    for (const address of lanAddresses()) row('local', `http://${address}:${config.port}`);
    if (['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
      row('bind', yellow(`${config.host}: only this machine can connect`));
    }

    rule('runtimes');
    if (this.runtimes.length === 0) {
      out.push(`  ${dim('nothing detected yet')}`);
    }
    for (const runtime of this.runtimes) {
      const mark = runtime.state === 'ready' ? green('●') : yellow('○');
      const version = runtime.version ? dim(` ${runtime.version}`) : '';
      out.push(`  ${mark} ${runtime.label}${version}`);
      if (runtime.state !== 'ready' && runtime.detail) out.push(`      ${dim(clip(runtime.detail, width - 8))}`);
    }

    rule('tokens');
    if (config.tokenEnv) row('env', `${green('COMPANION_RUNNER_TOKEN')} ${dim('(always valid, not stored)')}`);
    const active = tokens.list().filter((token) => token.revokedAt === null);
    if (active.length === 0 && !config.tokenEnv) {
      out.push(`  ${red('no token can authenticate: press [n] to issue one')}`);
    }
    for (const token of active) {
      const used = token.lastUsedAt ? `used ${ago(token.lastUsedAt)}` : 'never used';
      out.push(`  ${cyan(token.id)} ${token.label.padEnd(28).slice(0, 28)} ${dim(used)}`);
    }

    rule('work');
    row('live runs', `${this.sources.liveRuns()} / ${config.maxRuns}`);

    rule('log');
    for (const line of this.logLines) out.push(`  ${dim(clip(line, width - 2))}`);

    out.push('');
    if (this.notice && Date.now() - this.noticeAt < 30_000) out.push(`  ${cyan('›')} ${this.notice}`);
    out.push('');
    out.push(dim('  [n] new token   [x] revoke older tokens   [t] publish   [r] re-detect   [q] quit'));

    process.stdout.write(CLEAR + out.join('\n') + '\n');
  };
}

function clip(text: string, width: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > width ? `${flat.slice(0, Math.max(0, width - 1))}…` : flat;
}

function ago(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

/** Non-internal IPv4 addresses: where this machine is reachable on its LAN. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const iface of Object.values(networkInterfaces())) {
    for (const info of iface ?? []) {
      if (info.family === 'IPv4' && !info.internal) out.push(info.address);
    }
  }
  return out;
}
