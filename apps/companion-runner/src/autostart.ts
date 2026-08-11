import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { logFile } from './background.js';

/**
 * `companion-runner autostart [off|status]` — register the agent with the OS
 * service manager so it starts on boot AND restarts after a crash: a launchd
 * LaunchAgent on macOS, a systemd user unit on Linux (crontab @reboot when
 * systemd is absent). The unit runs the agent in the foreground — the service
 * manager is the supervisor, not the pidfile.
 *
 * The current COMPANION_RUNNER_* environment (and PATH, which service managers
 * strip) is baked into the unit so boots behave exactly like the shell the
 * user attached from. Units are chmod 600 — they may carry the bearer token.
 */

const LABEL = 'com.moxxy.companion-runner';
const ENV_VARS = [
  'COMPANION_RUNNER_HOME',
  'COMPANION_RUNNER_TOKEN',
  'COMPANION_RUNNER_HOST',
  'COMPANION_RUNNER_PORT',
  'COMPANION_RUNNER_MAX_RUNS',
  'COMPANION_RUNNER_GITHUB_TOKEN',
] as const;

function bakedEnv(): Array<[string, string]> {
  const pairs: Array<[string, string]> = [['PATH', process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin']];
  for (const key of ENV_VARS) {
    const value = process.env[key]?.trim();
    if (value) pairs.push([key, value]);
  }
  return pairs;
}

/** The exact re-exec startBackground uses: this node running this script. */
function entry(): [string, string] {
  return [process.execPath, process.argv[1] ?? ''];
}

function sh(cmd: string, args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (err) {
    return { ok: false, out: String(err instanceof Error ? err.message : err) };
  }
}

function withInput(cmd: string, args: string[], input: string): { ok: boolean; out: string } {
  try {
    return {
      ok: true,
      out: execFileSync(cmd, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }),
    };
  } catch (err) {
    return { ok: false, out: String(err instanceof Error ? err.message : err) };
  }
}

function oneLine(value: string, context: string): string {
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw new Error(`${context} contains a line break or NUL byte`);
  }
  return value;
}

/** systemd expands `%` specifiers even inside quotes. */
function systemdQuote(value: string): string {
  return `"${oneLine(value, 'systemd value')
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('%', '%%')}"`;
}

/** A literal POSIX-shell word for the command cron will execute later. */
function cronQuote(value: string): string {
  return `'${oneLine(value, 'cron value').replaceAll("'", `'"'"'`)}'`;
}

export async function autostart(action: 'install' | 'off' | 'status'): Promise<number> {
  if (process.platform === 'darwin') return macos(action);
  if (process.platform === 'linux') return linux(action);
  process.stderr.write(`autostart is not supported on ${process.platform} — use your OS service manager directly.\n`);
  return 1;
}

// ---------- macOS (launchd LaunchAgent) --------------------------------------------

const plistPath = (): string => join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function macos(action: 'install' | 'off' | 'status'): number {
  const target = `gui/${userInfo().uid}`;
  if (action === 'status') {
    process.stdout.write(existsSync(plistPath()) ? `autostart is on (${plistPath()})\n` : 'autostart is off.\n');
    return 0;
  }
  if (action === 'off') {
    sh('launchctl', ['bootout', `${target}/${LABEL}`]);
    rmSync(plistPath(), { force: true });
    process.stdout.write('autostart removed.\n');
    return 0;
  }
  const [node, script] = entry();
  const env = bakedEnv()
    .map(([k, v]) => `      <key>${xml(k)}</key><string>${xml(v)}</string>`)
    .join('\n');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(node)}</string>
      <string>${xml(script)}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>${xml(logFile())}</string>
    <key>StandardErrorPath</key><string>${xml(logFile())}</string>
  </dict>
</plist>
`;
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(plistPath(), plist, { mode: 0o600 });
  // Re-registering an existing label needs a bootout first; a fresh install
  // fails that harmlessly. Older macOS lacks bootstrap — fall back to load -w.
  sh('launchctl', ['bootout', `${target}/${LABEL}`]);
  const boot = sh('launchctl', ['bootstrap', target, plistPath()]);
  if (!boot.ok) {
    const legacy = sh('launchctl', ['load', '-w', plistPath()]);
    if (!legacy.ok) {
      process.stderr.write(`could not register with launchd: ${boot.out}\n`);
      return 1;
    }
  }
  process.stdout.write(
    `autostart is on — launchd starts companion-runner at login and restarts it if it dies.\n` +
      `  unit: ${plistPath()}\n  off:  companion-runner autostart off\n`,
  );
  return 0;
}

// ---------- Linux (systemd user unit, crontab fallback) ----------------------------

const unitDir = (): string => join(homedir(), '.config', 'systemd', 'user');
const unitPath = (): string => join(unitDir(), 'companion-runner.service');
const CRON_MARK = '# companion-runner autostart';

function hasSystemd(): boolean {
  return sh('systemctl', ['--user', '--version']).ok;
}

function linux(action: 'install' | 'off' | 'status'): number {
  if (!hasSystemd()) return linuxCron(action);
  if (action === 'status') {
    process.stdout.write(existsSync(unitPath()) ? `autostart is on (${unitPath()})\n` : 'autostart is off.\n');
    return 0;
  }
  if (action === 'off') {
    sh('systemctl', ['--user', 'disable', '--now', 'companion-runner']);
    rmSync(unitPath(), { force: true });
    sh('systemctl', ['--user', 'daemon-reload']);
    process.stdout.write('autostart removed.\n');
    return 0;
  }
  const [node, script] = entry();
  const env = bakedEnv()
    .map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}`)
    .join('\n');
  const unit = `[Unit]
Description=Companion runner agent

[Service]
ExecStart=${systemdQuote(node)} ${systemdQuote(script)}
Restart=on-failure
RestartSec=5
${env}

[Install]
WantedBy=default.target
`;
  mkdirSync(unitDir(), { recursive: true });
  writeFileSync(unitPath(), unit, { mode: 0o600 });
  sh('systemctl', ['--user', 'daemon-reload']);
  const enable = sh('systemctl', ['--user', 'enable', '--now', 'companion-runner']);
  if (!enable.ok) {
    process.stderr.write(`could not enable the systemd unit: ${enable.out}\n`);
    return 1;
  }
  // Without linger the user unit only starts once the user logs in — useless
  // for a headless box. Best-effort; may need sudo on some distros.
  const linger = sh('loginctl', ['enable-linger', userInfo().username]);
  process.stdout.write(
    `autostart is on — systemd starts companion-runner at boot and restarts it on failure.\n` +
      `  unit: ${unitPath()}\n  off:  companion-runner autostart off\n` +
      (linger.ok
        ? ''
        : `  note: "loginctl enable-linger ${userInfo().username}" failed — run it (maybe with sudo) or the unit only starts at login.\n`),
  );
  return 0;
}

/** No systemd (containers, minimal distros): a crontab @reboot line. */
function linuxCron(action: 'install' | 'off' | 'status'): number {
  const existing = sh('crontab', ['-l']);
  const lines = existing.ok ? existing.out.split('\n') : [];
  const installed = lines.some((l) => l.includes(CRON_MARK));
  if (action === 'status') {
    process.stdout.write(installed ? 'autostart is on (crontab @reboot).\n' : 'autostart is off.\n');
    return 0;
  }
  const kept = lines.filter((l) => !l.includes(CRON_MARK) && l.trim() !== '');
  if (action === 'install') {
    const [node, script] = entry();
    const env = bakedEnv()
      .map(([k, v]) => `${k}=${cronQuote(v)}`)
      .join(' ');
    kept.push(`@reboot ${env} ${cronQuote(node)} ${cronQuote(script)} --background ${CRON_MARK}`);
  }
  const write = withInput('crontab', ['-'], `${kept.join('\n')}\n`);
  if (!write.ok) {
    process.stderr.write(`could not update crontab: ${write.out}\n`);
    return 1;
  }
  process.stdout.write(
    action === 'install'
      ? 'autostart is on — crontab starts companion-runner at reboot (no crash-restart without systemd).\n'
      : 'autostart removed.\n',
  );
  return 0;
}
