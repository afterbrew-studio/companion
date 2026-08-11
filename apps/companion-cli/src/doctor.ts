import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { readToken } from './client.js';
import { runningPid } from './daemon.js';
import { detectGhLogin } from './github.js';
import { readHarnessOptions } from './harnesses.js';
import { readStoredAuthMode } from './setup.js';
import { assertSupportedNode, MIN_NODE_MAJOR } from './preflight.js';
import { COMPANION_VERSION } from './version.js';

export { assertSupportedNode } from './preflight.js';
const RUNTIME_COMMANDS = [
  ['codex', 'Codex'],
  ['claude', 'Claude Code'],
  ['moxxy', 'Moxxy'],
] as const;

export const DOCTOR_HELP = `companion doctor: diagnose a local Companion installation

Usage:
  companion doctor [--json] [--home <path>] [--host <host>] [--port <port>]

Options:
  --json           Print a machine-readable, redacted report
  --home <path>    Inspect another Companion data directory
  --host <host>    Check another configured host
  --port <port>    Check another configured port
  -h, --help       Show this help

The report never includes credentials, repository contents, log contents,
absolute data paths, or the active GitHub username.
`;

type CheckStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  readonly id: string;
  readonly status: CheckStatus;
  readonly message: string;
  readonly fix?: string;
}

export interface DoctorReport {
  readonly companionVersion: string;
  readonly platform: string;
  readonly architecture: string;
  readonly ok: boolean;
  readonly checks: readonly DoctorCheck[];
}

export interface DoctorOptions {
  readonly home: string;
  readonly baseUrl: string;
  readonly host: string;
  readonly port: number;
  readonly json: boolean;
}

interface EndpointProbe {
  readonly reachable: boolean;
  readonly healthy: boolean;
}

interface CommandProbe {
  readonly installed: boolean;
  readonly ready: boolean;
}

export function parseDoctorArgs(argv: readonly string[]): { readonly json: boolean } {
  let json = false;
  for (const arg of argv) {
    if (arg === '--json') json = true;
    else throw new Error(`Unknown doctor argument: ${arg}\n\n${DOCTOR_HELP}`);
  }
  return { json };
}

export async function runDoctor(options: DoctorOptions): Promise<void> {
  const report = await collectDoctorReport(options);
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : renderDoctorReport(report));
  if (!report.ok) process.exitCode = 1;
}

export async function collectDoctorReport(options: DoctorOptions): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const node = process.versions.node;
  const major = nodeMajor(node);
  checks.push(
    major !== null && major >= MIN_NODE_MAJOR
      ? { id: 'node', status: 'pass', message: `Node.js ${node} is supported.` }
      : {
          id: 'node',
          status: 'fail',
          message: `Node.js ${node} is unsupported.`,
          fix: `Install Node.js ${MIN_NODE_MAJOR} or newer.`,
        },
  );

  const git = probeCommand('git', ['--version']);
  checks.push(
    git.ready
      ? { id: 'git', status: 'pass', message: 'Git is available.' }
      : {
          id: 'git',
          status: 'fail',
          message: git.installed ? 'Git is installed but cannot run.' : 'Git is not installed.',
          fix: 'Install Git and make it available on PATH.',
        },
  );

  const home = inspectHome(options.home);
  checks.push(
    home.writable
      ? {
          id: 'data-directory',
          status: 'pass',
          message: home.exists
            ? 'The configured data directory is writable.'
            : 'The configured data directory can be created.',
        }
      : {
          id: 'data-directory',
          status: 'fail',
          message: 'The configured data directory is not writable.',
          fix: 'Choose a writable --home or repair its ownership and permissions.',
        },
  );

  const authMode = readStoredAuthMode(options.home);
  checks.push(
    authMode
      ? { id: 'configuration', status: 'pass', message: `The installation uses ${authMode} authentication.` }
      : {
          id: 'configuration',
          status: 'warn',
          message: 'This data directory has not been initialized.',
          fix: 'Run npx @moxxy/companion to initialize it.',
        },
  );

  const loopback = isLoopback(options.host);
  checks.push(
    authMode === 'local' && !loopback
      ? {
          id: 'bind',
          status: 'fail',
          message: `Trusted local mode is configured for a network bind on port ${options.port}.`,
          fix: 'Use loopback, or initialize a fresh data directory with --with-auth.',
        }
      : {
          id: 'bind',
          status: loopback ? 'pass' : 'warn',
          message: `${loopback ? 'Loopback' : 'Network'} bind is configured on port ${options.port}.`,
          ...(loopback ? {} : { fix: 'Confirm HTTPS, authentication, firewall, and proxy settings before exposure.' }),
        },
  );

  const pid = runningPid(options.home);
  const endpoint = await probeEndpoint(options.baseUrl);
  const daemonReady = pid !== null && endpoint.healthy;
  if (daemonReady) {
    checks.push({ id: 'daemon', status: 'pass', message: 'The daemon owns this data directory and is healthy.' });
  } else if (pid !== null) {
    checks.push({
      id: 'daemon',
      status: 'fail',
      message: 'A daemon owns this data directory, but its health endpoint is unavailable.',
      fix: 'Inspect companiond.log, then stop and restart Companion.',
    });
  } else if (endpoint.healthy) {
    checks.push({
      id: 'daemon',
      status: 'warn',
      message: 'A healthy service answers at the configured address, but this data directory has no local owner lock.',
      fix: 'Confirm that --home, --host, and --port refer to the same instance.',
    });
  } else if (endpoint.reachable) {
    checks.push({
      id: 'daemon',
      status: 'fail',
      message: 'The configured address is occupied by a service that is not Companion.',
      fix: 'Choose another --port or stop the process using this address.',
    });
  } else {
    checks.push({
      id: 'daemon',
      status: 'warn',
      message: 'Companion is not running at the configured address.',
      fix: 'Run npx @moxxy/companion to start it.',
    });
  }

  const cliToken = daemonReady ? optionalCliToken() : null;
  if (daemonReady) {
    checks.push(
      cliToken
        ? { id: 'cli-access', status: 'pass', message: 'CLI access to the running daemon is configured.' }
        : {
            id: 'cli-access',
            status: 'warn',
            message: 'The daemon is healthy, but no CLI credential is available.',
            fix: 'Complete first-admin setup if needed, then restart Companion.',
          },
    );
  }

  const gh = probeCommand('gh', ['--version']);
  if (!gh.installed) {
    checks.push({
      id: 'github-cli',
      status: 'warn',
      message: 'GitHub CLI is not installed; automatic account adoption is unavailable.',
      fix: 'Install gh, then run gh auth login.',
    });
  } else if (!gh.ready || !detectGhLogin()) {
    checks.push({
      id: 'github-cli',
      status: 'warn',
      message: 'GitHub CLI is installed but has no active authenticated github.com account.',
      fix: 'Run gh auth login.',
    });
  } else {
    checks.push({ id: 'github-cli', status: 'pass', message: 'GitHub CLI has an active authenticated account.' });
  }

  await addRuntimeCheck(checks, options, daemonReady, cliToken);
  return {
    companionVersion: COMPANION_VERSION,
    platform: process.platform,
    architecture: process.arch,
    ok: !checks.some((check) => check.status === 'fail'),
    checks,
  };
}

export function renderDoctorReport(report: DoctorReport): string {
  const lines = [
    `Companion doctor ${report.companionVersion}`,
    `${report.platform} ${report.architecture}`,
    '',
    ...report.checks.flatMap((check) => {
      const marker = check.status === 'pass' ? 'PASS' : check.status === 'warn' ? 'WARN' : 'FAIL';
      return [`[${marker}] ${check.message}`, ...(check.fix ? [`       ${check.fix}`] : [])];
    }),
    '',
    report.ok ? 'No blocking problem found.' : 'One or more blocking problems need attention.',
    'This report is redacted and safe to attach to a public issue after you review it.',
    '',
  ];
  return lines.join('\n');
}

async function addRuntimeCheck(
  checks: DoctorCheck[],
  options: DoctorOptions,
  daemonReady: boolean,
  token: string | null,
): Promise<void> {
  if (daemonReady && token) {
    const result = await readHarnessOptions(options.baseUrl, token, 2_000);
    if (result) {
      const ready = result.options.filter((runtime) => runtime.state === 'ready').map((runtime) => runtime.label);
      const installed = result.options.filter((runtime) => runtime.state === 'installed').map((runtime) => runtime.label);
      if (ready.length) {
        checks.push({ id: 'agent-runtime', status: 'pass', message: `Ready agent runtimes: ${ready.join(', ')}.` });
      } else {
        checks.push({
          id: 'agent-runtime',
          status: 'warn',
          message: installed.length
            ? `Installed agent runtimes need attention: ${installed.join(', ')}.`
            : 'No agent runtime is ready on this machine.',
          fix: 'Sign in to an installed runtime, or install Codex, Claude Code, or Moxxy.',
        });
      }
      return;
    }
  }

  const installed = RUNTIME_COMMANDS.filter(([command]) => probeCommand(command, ['--version']).installed).map(
    ([, label]) => label,
  );
  checks.push(
    installed.length
      ? {
          id: 'agent-runtime',
          status: 'warn',
          message: `Installed agent runtimes detected without daemon readiness: ${installed.join(', ')}.`,
          fix: 'Start Companion to verify runtime authentication and capabilities.',
        }
      : {
          id: 'agent-runtime',
          status: 'warn',
          message: 'No supported agent runtime was detected on PATH.',
          fix: 'Install Codex, Claude Code, or Moxxy before starting agent work.',
        },
  );
}

function nodeMajor(version: string): number | null {
  const first = version.split('.', 1)[0];
  if (!first) return null;
  const major = Number(first);
  return Number.isInteger(major) ? major : null;
}

function probeCommand(command: string, args: readonly string[]): CommandProbe {
  const result = spawnSync(command, [...args], { stdio: 'ignore', timeout: 2_000 });
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return { installed: code !== 'ENOENT', ready: !result.error && result.status === 0 };
}

function inspectHome(home: string): { readonly exists: boolean; readonly writable: boolean } {
  if (existsSync(home)) {
    try {
      if (!statSync(home).isDirectory()) return { exists: true, writable: false };
      accessSync(home, constants.R_OK | constants.W_OK | constants.X_OK);
      return { exists: true, writable: true };
    } catch {
      return { exists: true, writable: false };
    }
  }
  let parent = dirname(home);
  while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
  try {
    accessSync(parent, constants.W_OK | constants.X_OK);
    return { exists: false, writable: true };
  } catch {
    return { exists: false, writable: false };
  }
}

function optionalCliToken(): string | null {
  const explicit = process.env.COMPANION_TOKEN?.trim();
  if (explicit) return explicit;
  try {
    return readToken();
  } catch {
    return null;
  }
}

async function probeEndpoint(baseUrl: string): Promise<EndpointProbe> {
  try {
    const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(2_000) });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // A reachable non-Companion service is useful evidence of a port collision.
    }
    return {
      reachable: true,
      healthy:
        response.ok &&
        typeof body === 'object' &&
        body !== null &&
        (body as { readonly ok?: unknown }).ok === true,
    };
  } catch {
    return { reachable: false, healthy: false };
  }
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}
