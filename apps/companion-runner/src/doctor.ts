import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { paths } from '@moxxy/companion-services';
import { detectMoxxyCli, MIN_MOXXY_VERSION } from '@companion/module-operate/exec';
import { homeStatus, importProvidersFromDailyMoxxy } from '@companion/module-operate/exec';
import { loadRunnerConfig } from './config.js';
import { openFirewall } from './firewall.js';
import { CliHarnessSessions } from './harnesses.js';
import { RunnerTokens } from './tokens.js';

const execFileP = promisify(execFile);

type Level = 'ok' | 'warn' | 'fail';
interface Check {
  readonly label: string;
  readonly level: Level;
  readonly detail: string;
  /** A shell hint the user can run to fix it. */
  readonly fix?: string;
}

const GLYPH: Record<Level, string> = { ok: '✓', warn: '!', fail: '✗' };

/**
 * `companion-runner doctor` — verify a box is ready to execute Companion agent
 * work, and with `setup` (or `doctor --fix`) install/repair what's missing:
 * the moxxy CLI, provider credentials, the data root. Everything here is what
 * an agent run needs, checked before you wire the machine into Companion.
 */
export async function runDoctor(opts: { fix: boolean }): Promise<number> {
  const config = loadRunnerConfig();
  const checks: Check[] = [];

  // Node
  const major = Number(process.versions.node.split('.')[0]);
  checks.push({
    label: 'Node.js',
    // The version this package declares in `engines`; a lower one installs
    // nothing and would fail here for a reason doctor could not name.
    level: major >= 24 ? 'ok' : 'fail',
    detail: `v${process.versions.node}${major >= 24 ? '' : ', need >= 24'}`,
  });

  // git
  try {
    const { stdout } = await execFileP('git', ['--version']);
    checks.push({ label: 'git', level: 'ok', detail: stdout.trim() });
  } catch {
    checks.push({ label: 'git', level: 'fail', detail: 'not found on PATH', fix: 'install git' });
  }

  // moxxy CLI — the core prerequisite. Install it on --fix.
  let moxxy = await detectMoxxyCli(paths.moxxyHome());
  if (!moxxy && opts.fix) {
    process.stdout.write(`\nInstalling the moxxy CLI (npm i -g @moxxy/cli)…\n`);
    const installed = await installMoxxy();
    if (installed) moxxy = await detectMoxxyCli(paths.moxxyHome());
  }
  if (!moxxy) {
    checks.push({
      label: 'moxxy CLI',
      level: 'fail',
      detail: 'not found on PATH',
      fix: 'npm i -g @moxxy/cli   (or run: companion-runner setup)',
    });
  } else if (!moxxy.compatible) {
    checks.push({
      label: 'moxxy CLI',
      level: 'warn',
      detail: `v${moxxy.version} is older than ${MIN_MOXXY_VERSION}`,
      fix: 'npm i -g @moxxy/cli@latest',
    });
  } else {
    checks.push({ label: 'moxxy CLI', level: 'ok', detail: `v${moxxy.version} at ${moxxy.path}` });
  }

  // Agent runtimes installed here. This is the answer to "why does Companion
  // not offer my laptop's Claude Code": what this prints is exactly what the
  // daemon is told, so a runtime missing here is missing there.
  const cli = new CliHarnessSessions(
    () => undefined,
    () => undefined,
    () => undefined,
  );
  for (const runtime of await cli.runtimes()) {
    if (runtime.id === 'moxxy') continue; // reported above, with its own fix hint
    checks.push({
      label: runtime.label,
      level: runtime.state === 'ready' ? 'ok' : 'warn',
      detail: runtime.state === 'ready' ? `v${runtime.version ?? '?'} ready` : (runtime.detail ?? 'installed'),
    });
  }

  // Provider credentials — import from ~/.moxxy on --fix when available.
  let providers = homeStatus().providersImported;
  if (!providers && opts.fix && existsSync(join(homedir(), '.moxxy'))) {
    importProvidersFromDailyMoxxy();
    providers = homeStatus().providersImported;
  }
  checks.push({
    label: 'Model providers',
    level: providers ? 'ok' : 'warn',
    detail: providers
      ? 'credentials present in the runner home'
      : 'none imported — runs cannot call a model until a provider is configured',
    fix: providers
      ? undefined
      : existsSync(join(homedir(), '.moxxy'))
        ? 'companion-runner setup   (imports from your ~/.moxxy)'
        : 'configure a provider in moxxy on this box, then: companion-runner setup',
  });

  // Bind host — a remote Companion can't reach a loopback-only bind.
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(config.host);
  checks.push({
    label: 'Bind host',
    level: loopback ? 'warn' : 'ok',
    detail: loopback
      ? `${config.host} — reachable only from this machine; a remote Companion cannot connect`
      : `${config.host} — listening on all interfaces`,
    fix: loopback ? 'set COMPANION_RUNNER_HOST=0.0.0.0 (then allow the port through your firewall)' : undefined,
  });

  // Port — is it bindable, or already taken? (An already-running agent shows as in-use.)
  const portState = await probePort(config.host, config.port);
  checks.push({
    label: `Port ${config.port}`,
    level: portState === 'free' || portState === 'in-use' ? (portState === 'free' ? 'ok' : 'warn') : 'fail',
    detail:
      portState === 'free'
        ? 'free to bind'
        : portState === 'in-use'
          ? 'already in use — fine if this runner is already running, otherwise a conflict'
          : `cannot bind ${config.host}:${config.port}`,
    fix:
      portState === 'in-use'
        ? 'if that is not this runner, pick another with COMPANION_RUNNER_PORT'
        : portState === 'error'
          ? 'choose a bindable host/port via COMPANION_RUNNER_HOST / COMPANION_RUNNER_PORT'
          : undefined,
  });

  // Reachability — the URL(s) to register in Companion + the firewall reminder.
  const addrs = lanAddresses();
  checks.push({
    label: 'Reachable at',
    level: 'ok',
    detail:
      addrs.length > 0
        ? addrs.map((a) => `http://${a}:${config.port}`).join('  ')
        : `http://<this-host>:${config.port}`,
    fix: 'open this port to the machine running Companion — "companion-runner open-firewall" handles the host firewall; cloud security groups must be opened in your provider. External openness can only be confirmed from Companion — use "Test connection" after registering.',
  });

  // GitHub token — optional: Companion sends its own credential with each git
  // operation; the env var is a per-machine override.
  checks.push({
    label: 'GitHub token',
    level: 'ok',
    detail: config.githubToken
      ? 'COMPANION_RUNNER_GITHUB_TOKEN set — this machine uses its own credential'
      : 'not set — Companion supplies its configured GitHub credential per git operation',
  });

  // Auth tokens. Their secrets are not stored, so this can only report how many
  // could authenticate, which is the one thing worth checking before attaching.
  const tokens = new RunnerTokens(config.home, config.tokenEnv);
  const active = tokens.list().filter((token) => token.revokedAt === null).length;
  tokens.close();
  checks.push({
    label: 'Runner tokens',
    level: tokens.usable ? 'ok' : 'warn',
    detail: config.tokenEnv
      ? `COMPANION_RUNNER_TOKEN is set${active ? `, plus ${active} stored` : ''}`
      : active > 0
        ? `${active} active. Secrets are not stored, so issue a new one if you lost it`
        : 'none: nothing can authenticate to this machine yet',
    fix: tokens.usable ? undefined : 'companion-runner token new',
  });

  // ---- report ----
  process.stdout.write(`\ncompanion-runner doctor — data root: ${config.home}\n\n`);
  for (const c of checks) {
    process.stdout.write(`  ${GLYPH[c.level]} ${c.label.padEnd(16)} ${c.detail}\n`);
    // Fix hints show for problems, and for the informational reachability note.
    if (c.fix && (c.level !== 'ok' || c.label === 'Reachable at')) {
      process.stdout.write(`      ↳ ${c.fix}\n`);
    }
  }

  // Host firewall — setup opens the port (sudo may prompt); doctor only hints.
  if (opts.fix) {
    process.stdout.write(`\nMaking sure TCP ${config.port} is open on the host firewall…\n`);
    await openFirewall(config.port);
  }

  const fails = checks.filter((c) => c.level === 'fail').length;
  const warns = checks.filter((c) => c.level === 'warn').length;
  process.stdout.write(
    `\n${fails === 0 ? (warns === 0 ? 'All good — this machine is ready to attach.' : `Ready with ${warns} warning(s).`) : `${fails} problem(s) to fix before this machine can run agents.`}\n`,
  );
  if (fails > 0 && !opts.fix) {
    process.stdout.write(`Run "companion-runner setup" to install and fix what it can automatically.\n`);
  }
  process.stdout.write(
    '\nNext:\n' +
      '  companion-runner token new           issue the credential Companion presents\n' +
      '  companion-runner ui                  start it with a live dashboard\n' +
      '  companion-runner --background        …or detached, logging to <home>/runner.log\n' +
      '  companion-runner --tunnel            publish this machine at a public https URL,\n' +
      '                                       which is how a cloud Companion reaches a laptop\n' +
      'Then add it in Companion → Runners with that URL and the token.\n' +
      '(GitHub access is supplied by Companion; "companion-runner open-firewall" opens the port.)\n\n',
  );
  return fails > 0 ? 1 : 0;
}

/** Install the moxxy CLI globally, streaming npm's output. */
function installMoxxy(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('npm', ['install', '-g', '@moxxy/cli'], { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

/**
 * Can we bind the configured host:port? `free` if the listen succeeds,
 * `in-use` on EADDRINUSE (often this very runner already running), `error`
 * otherwise (e.g. the host isn't a local interface). Local-only — external
 * firewall openness can't be self-tested from the runner's own box.
 */
function probePort(host: string, port: number): Promise<'free' | 'in-use' | 'error'> {
  return new Promise((resolve) => {
    const srv = createServer();
    let settled = false;
    const done = (r: 'free' | 'in-use' | 'error'): void => {
      if (settled) return;
      settled = true;
      srv.close(() => resolve(r));
    };
    srv.once('error', (err: NodeJS.ErrnoException) => {
      if (!settled) {
        settled = true;
        resolve(err.code === 'EADDRINUSE' ? 'in-use' : 'error');
      }
    });
    // Verify something can actually connect once we're listening.
    srv.listen(port, host === '0.0.0.0' ? undefined : host, () => {
      const probe = connect(port, host === '0.0.0.0' ? '127.0.0.1' : host);
      probe.once('connect', () => {
        probe.destroy();
        done('free');
      });
      probe.once('error', () => done('free')); // bound but self-connect blocked — still bindable
      setTimeout(() => done('free'), 1_000);
    });
  });
}

/** Non-internal IPv4 addresses — the endpoints to register in Companion. */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const iface of Object.values(networkInterfaces())) {
    for (const info of iface ?? []) {
      if (info.family === 'IPv4' && !info.internal) out.push(info.address);
    }
  }
  return out;
}
