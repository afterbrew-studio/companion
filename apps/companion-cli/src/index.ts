import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  applyPendingAdminSetup,
  consumePendingAdminSetup,
  createDefaultAdmin,
  readAdminSetup,
  renderSetupBox,
  setupExists,
  validateEmail,
  validatePassword,
  validateUsername,
  takePendingProfile,
  writePendingAdminSetup,
  writePendingProfile,
} from './setup.js';
import type { AdminSetup } from './setup.js';
import {
  installModules,
  modulesFor,
  OPTIONAL_MODULES,
  PROFILE_CHOICES,
  profileFromEnv,
  requires,
  waitForToken,
  withDependencies,
  type ProfileId,
} from './profile.js';
import {
  harnessChoices,
  NOTHING_INSTALLED,
  readHarnessOptions,
  saveHarnesses,
} from './harnesses.js';
import { backupDatabase, restoreDatabase } from './backup.js';
import { RUN_HELP, parseRunCommand, runRunCommand } from './runs.js';
import { connectGhAccount, detectGhLogin, importPendingGhAccount, pendingGhLogin, scheduleGhImport } from './github.js';
import { MODULE_HELP, parseModuleCommand, runModuleCommand } from './modules.js';
import { ACL_HELP, parseAclCommand, runAclCommand } from './acl.js';

/** Commands that talk to a running daemon instead of starting one. */
const CLIENT_COMMANDS = ['module', 'acl', 'role', 'user', 'run'] as const;
type ClientCommand = (typeof CLIENT_COMMANDS)[number];

interface CliOptions {
  readonly command: 'start' | 'init' | 'connect-github' | 'backup' | 'restore' | ClientCommand;
  readonly home: string;
  readonly host?: string;
  readonly port?: number;
  readonly open: boolean;
  readonly yes: boolean;
  readonly githubFromGh: boolean;
  readonly verbose: boolean;
  /** Positional path for `backup` / `restore`. */
  readonly file?: string;
}

/**
 * The mark rasterized from its own geometry by docs/brand/ascii.mjs. The dot is
 * emerald because green already means AI everywhere else in this product; it is
 * the only element of the mark allowed to carry colour.
 */
const BANNER = `
                 .....
           ..:###########:.
         .:#################:.
       .#####:..       .:#####:
      .####:              .:##:
     .####.
     ####.                   \x1b[38;5;42m.:::.\x1b[0m
     ####                   \x1b[38;5;42m.######\x1b[0m
     ####                   \x1b[38;5;42m.######\x1b[0m
     ####.                   \x1b[38;5;42m.:::.\x1b[0m
     .####.
      .####:              .:##:
       .#####:..       .:#####:
         .:#################:.
           ..:###########:.
                 .....

           c o m p a n i o n

`;

const HELP = `@moxxy/companion: run Companion locally

Usage:
  npx @moxxy/companion                  Initialize when needed, start, open browser
  npx @moxxy/companion init             Create the local admin configuration only
  npx @moxxy/companion connect-github   Connect active gh to an existing Companion user
  npx @moxxy/companion run list         Runs awaiting you; also show/diff/approve/discard
  npx @moxxy/companion backup [file]    Snapshot the database (safe while running)
  npx @moxxy/companion restore <file>   Replace the database from a snapshot (stop first)
  npx @moxxy/companion module ...       Inspect and toggle modules (see: module --help)
  npx @moxxy/companion acl ...          Inspect the live permission grid (see: acl --help)
  npx @moxxy/companion role ...         Create and edit roles
  npx @moxxy/companion user role <username> <role>

Options:
  --home <path>    Data directory (default: COMPANION_HOME or ~/.companion)
  --host <host>    Bind host for this run (default: 127.0.0.1)
  --port <port>    HTTP port for this run (default: 8901)
  --no-open        Do not open a browser
  -y, --yes        Accept secure generated defaults without prompting
  --github-from-gh Connect the active local gh account to the new admin
  --verbose        Show daemon startup and diagnostic logs
  -h, --help       Show this help

Agent work runs through a harness installed on this machine (the moxxy CLI, or
Claude Code). First run detects what is there and asks which of them to use.
`;

class SetupCancelled extends Error {}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const group = CLIENT_COMMANDS.find((c) => c === argv[0]);
  if (group) {
    const { cli, rest } = splitClientArgs(argv);
    if (!rest.length || rest.includes('--help') || rest.includes('-h')) {
      process.stdout.write(group === 'module' ? MODULE_HELP : group === 'run' ? RUN_HELP : ACL_HELP);
      return;
    }
    const options = parseArgs([group, ...cli]);
    // paths.cliToken() and the stored address both resolve from COMPANION_HOME.
    process.env.COMPANION_HOME = options.home;
    const { host, port } = resolveAddress(options);
    const url = localUrl(host, port);
    if (group === 'module') await runModuleCommand(parseModuleCommand(rest), url);
    else if (group === 'run') await runRunCommand(parseRunCommand(rest), url);
    else await runAclCommand(parseAclCommand(group, rest, options.home), url);
    return;
  }

  const options = parseArgs(argv);
  if (options.command === 'backup' || options.command === 'restore') {
    process.env.COMPANION_HOME = options.home;
    const { host, port } = resolveAddress(options);
    const url = localUrl(host, port);
    if (options.command === 'backup') {
      const target =
        options.file ?? join(options.home, `companion-backup-${new Date().toISOString().slice(0, 10)}.db`);
      await backupDatabase(options.home, target, url);
    } else {
      if (!options.file) throw new Error('Which snapshot? Usage: companion restore <file>');
      await restoreDatabase(options.home, options.file, url);
    }
    return;
  }
  if (options.command === 'connect-github') {
    await connectGithub(options);
    return;
  }
  // Decoration, so only when a person is watching: piped output stays clean.
  // NO_COLOR still gets the mark, just without the emerald on the dot.
  if (process.stdout.isTTY) {
    process.stdout.write(process.env.NO_COLOR ? BANNER.replace(/\x1b\[[0-9;]*m/g, '') : BANNER);
  }
  if (!setupExists(options.home)) await initialize(options);
  else if (options.command === 'init') {
    process.stdout.write(`Companion is already initialized in ${options.home}\n`);
    return;
  }
  if (options.command === 'init') return;
  await start(options);
}

async function connectGithub(options: CliOptions): Promise<void> {
  const { host, port } = resolveAddress(options);
  const url = localUrl(host, port);
  if (!(await waitForHealth(url, 2_000))) {
    throw new Error(`Companion is not running at ${url}. Start it first, then retry.`);
  }

  const ghLogin = detectGhLogin();
  if (!ghLogin) throw new Error('gh is not authenticated for github.com. Run `gh auth login` and retry.');
  const stored = readAdminSetup(options.home);
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && !options.yes);
  let credentials = stored;
  if (interactive) {
    const { input, password } = await import('@inquirer/prompts');
    const username = await input({
      message: 'Companion username',
      default: stored?.username ?? 'admin',
      validate: validateUsername,
    });
    const chosenPassword = await password({
      message: 'Companion password',
      mask: '*',
      validate: (value) => value.length > 0 || 'Enter your Companion password.',
    });
    credentials = {
      username: username.trim(),
      password: chosenPassword,
      email: stored?.email ?? '',
      generatedPassword: false,
    };
  }
  if (!credentials) {
    throw new Error(
      'Companion credentials are required in non-interactive mode. Set COMPANION_ADMIN_USER and COMPANION_ADMIN_PASSWORD or run interactively.',
    );
  }

  process.stdout.write(`Connecting active gh account ${ghLogin} to Companion user ${credentials.username} at ${url}...\n`);
  try {
    await connectGhAccount(url, credentials, ghLogin);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/invalid credentials/i.test(message)) {
      throw new Error(
        'Companion rejected those credentials. Admin env variables only seed an empty database; enter the existing Companion username and password.',
      );
    }
    throw err;
  }
  process.stdout.write(`Connected GitHub account ${ghLogin} to Companion user ${credentials.username}.\n`);
}

async function initialize(options: CliOptions): Promise<void> {
  process.stdout.write('\nWelcome to Companion.\n\n');
  const defaults = createDefaultAdmin();
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && !options.yes);
  const setup = interactive ? await promptForAdmin(defaults) : defaults;
  const { host, port } = resolveAddress(options);
  const url = localUrl(host, port);
  process.stdout.write(`${renderSetupBox(setup, options.home, url)}\n`);

  const ghLogin = detectGhLogin();
  let connectGh = options.githubFromGh && ghLogin !== null;
  if (interactive) {
    const { confirm } = await import('@inquirer/prompts');
    const accepted = await confirm({ message: 'Create this local configuration?', default: true });
    if (!accepted) throw new SetupCancelled('Setup cancelled.');
    if (ghLogin) {
      connectGh = await confirm({
        message: `Connect active gh account ${ghLogin} to the Companion admin?`,
        default: true,
      });
    }
  } else {
    process.stdout.write('Using secure generated defaults because prompting was skipped.\n');
  }

  const modules = await resolveProfile(options);
  writePendingProfile(options.home, modules);

  const file = writePendingAdminSetup(options.home, setup);
  if (connectGh && ghLogin) {
    scheduleGhImport(options.home, ghLogin);
    process.stdout.write(`Will connect gh account ${ghLogin} to admin ${setup.username} when Companion starts.\n`);
  } else if (options.githubFromGh && !ghLogin) {
    process.stderr.write('Could not find an active github.com account in gh; continuing without GitHub import.\n');
  }
  process.stdout.write(`\nSaved one-time bootstrap data in ${file} with owner-only permissions.\n`);
  if (setup.generatedPassword) process.stdout.write('Save the generated password now; it will not be shown on later starts.\n');
  if (options.command === 'init') process.stdout.write('\nNext: npx @moxxy/companion\n');
}

/**
 * Which optional modules to turn on. `COMPANION_PROFILE` answers it without a
 * prompt, which is what a scripted or containerised install needs; `-y` takes
 * the recommendation.
 */
async function resolveProfile(options: CliOptions): Promise<readonly string[]> {
  const fromEnv = profileFromEnv();
  if (fromEnv) {
    process.stdout.write(`Module set: ${fromEnv} (from COMPANION_PROFILE).\n`);
    return modulesFor(fromEnv);
  }
  if (options.yes || !process.stdin.isTTY) return modulesFor('slim');

  const { checkbox, select } = await import('@inquirer/prompts');
  const profile = await select<ProfileId>({
    message: 'Which modules should this instance start with?',
    choices: PROFILE_CHOICES.map((c) => ({ value: c.value, name: c.name, description: c.description })),
    default: 'slim',
  });
  if (profile !== 'custom') return modulesFor(profile);

  const picked = await checkbox<string>({
    message: 'Choose the optional modules',
    // What a tick costs goes in the NAME, not the description: inquirer only
    // shows a description while its row is highlighted, and someone ticking
    // "Ideas" would otherwise learn it brought three others along after
    // confirming, which is the wrong moment to find out.
    choices: OPTIONAL_MODULES.map((m) => {
      const needs = requires(m.id);
      return {
        value: m.id,
        name: needs.length ? `${m.label}  (also enables ${needs.join(', ')})` : m.label,
        description: m.hint,
      };
    }),
  });
  const closed = withDependencies(picked);
  const added = closed.filter((id) => !picked.includes(id));
  if (added.length) process.stdout.write(`Also enabling ${added.join(', ')}, which the selection depends on.\n`);
  return closed;
}

async function promptForAdmin(defaults: AdminSetup): Promise<AdminSetup> {
  const { confirm, input, password } = await import('@inquirer/prompts');
  const useDefaults = await confirm({
    message: 'Use recommended local admin defaults (including a generated password)?',
    default: true,
  });
  if (useDefaults) return defaults;

  const username = await input({ message: 'Admin username', default: defaults.username, validate: validateUsername });
  const email = await input({ message: 'Admin email', default: defaults.email, validate: validateEmail });
  const chosen = await password({ message: 'Admin password', mask: '*', validate: validatePassword });
  await password({
    message: 'Confirm password',
    mask: '*',
    validate: (value) => value === chosen || 'Passwords do not match.',
  });
  return { username: username.trim(), email: email.trim(), password: chosen, generatedPassword: false };
}

async function start(options: CliOptions): Promise<void> {
  const { host, port } = resolveAddress(options);
  const url = localUrl(host, port);
  const bundleDir = dirname(fileURLToPath(import.meta.url));
  const staticDir = join(bundleDir, 'web');
  const server = join(bundleDir, 'server.js');
  if (!existsSync(join(staticDir, 'index.html')) || !existsSync(server)) {
    throw new Error('Companion bundle is incomplete. Reinstall @moxxy/companion.');
  }

  process.env.COMPANION_HOME = options.home;
  // The one-command experience stays focused on actionable status. Warnings
  // and errors still surface; developers running `pnpm dev` keep full logs.
  if (options.verbose) process.env.COMPANION_LOG_LEVEL = 'info';
  else process.env.COMPANION_LOG_LEVEL ??= 'warn';
  const pendingAdmin = applyPendingAdminSetup(options.home);
  if (pendingAdmin) process.env.COMPANION_IMPORT_LOCAL_GH = pendingGhLogin(options.home) ? 'true' : 'false';
  process.env.COMPANION_STATIC_DIR = staticDir;
  if (options.host !== undefined) process.env.COMPANION_HOST = options.host;
  if (options.port !== undefined) process.env.COMPANION_PORT = String(options.port);
  process.chdir(options.home);

  process.stdout.write(`\nStarting Companion at ${url}\nData directory: ${options.home}\nPress Ctrl+C to stop.\n\n`);
  const pendingModules = takePendingProfile(options.home);
  const ready = waitForHealth(url, 30_000);
  await import(pathToFileURL(server).href);
  if (!(await ready)) {
    process.stderr.write(`Companion did not become ready within 30 seconds. Check the logs above.\n`);
    return;
  }
  if (pendingModules.length) {
    process.stdout.write(`Enabling ${pendingModules.length} optional module(s)…\n`);
    await installModules(url, pendingModules, (line) => process.stdout.write(`${line}\n`));
  }
  // Only on a first run: the machine's runtimes are settled once, and every
  // later start would otherwise re-ask a question that already has an answer.
  if (pendingAdmin) await settleHarnesses(url, options);
  process.stdout.write(`\nCompanion is ready: ${url}\n`);
  const admin = pendingAdmin ?? readAdminSetup(options.home);
  if (admin) {
    try {
      const githubLogin = await importPendingGhAccount(options.home, url, admin);
      if (githubLogin) process.stdout.write(`Connected GitHub account ${githubLogin} to admin ${admin.username}.\n`);
    } catch (err) {
      process.stderr.write(
        `${err instanceof Error ? err.message : String(err)}\nSign in with the saved Companion password, then run \`npx @moxxy/companion connect-github\`.\n`,
      );
    }
  }
  if (pendingAdmin) consumePendingAdminSetup(options.home);
  if (options.open) openBrowser(url);
}

/**
 * Which agent runtimes this machine will use, asked once, from what is actually
 * installed on it.
 *
 * Silent when the daemon does not answer: an instance without the execution
 * module has no such question, and saying nothing is better than explaining an
 * absence. Non-interactive runs keep the default, which is moxxy, because a
 * scripted install must not have its execution plane changed by whatever
 * happens to be on the box.
 */
async function settleHarnesses(url: string, options: CliOptions): Promise<void> {
  const token = await waitForToken();
  if (!token) return;
  const answer = await readHarnessOptions(url, token);
  if (!answer) return;
  if (answer.options.length === 0) {
    process.stdout.write(`\n${NOTHING_INSTALLED}\n`);
    return;
  }
  if (options.yes || !process.stdin.isTTY) return;

  const { checkbox } = await import('@inquirer/prompts');
  const picked = await checkbox<string>({
    message: 'Which agent runtimes should this machine use?',
    choices: harnessChoices(answer.options).map((c) => ({ ...c })),
  });
  if (picked.length === 0) {
    process.stdout.write('Nothing ticked, so this machine keeps its current runtime.\n');
    return;
  }
  try {
    await saveHarnesses(url, token, picked);
    process.stdout.write(`Agent work here runs through ${picked.join(', ')}.\n`);
  } catch (err) {
    process.stderr.write(`Could not save the runtime choice: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

function parseArgs(argv: readonly string[]): CliOptions {
  let command: CliOptions['command'] = 'start';
  let home = process.env.COMPANION_HOME || join(homedir(), '.companion');
  let host: string | undefined;
  let port: number | undefined;
  let open = true;
  let yes = false;
  let githubFromGh = false;
  let verbose = false;
  let file: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (CLIENT_COMMANDS.some((c) => c === arg) && command === 'start') command = arg as ClientCommand;
    else if ((arg === 'init' || arg === 'connect-github') && command === 'start') command = arg;
    else if ((arg === 'backup' || arg === 'restore') && command === 'start') command = arg;
    // The one positional: the snapshot path these two commands operate on.
    else if ((command === 'backup' || command === 'restore') && !arg.startsWith('-') && file === undefined) file = arg;
    else if (arg === '--home') home = requiredValue(argv, ++i, arg);
    else if (arg === '--host') host = requiredValue(argv, ++i, arg);
    else if (arg === '--port') port = validPort(requiredValue(argv, ++i, arg));
    else if (arg === '--no-open') open = false;
    else if (arg === '--yes' || arg === '-y') yes = true;
    else if (arg === '--github-from-gh') githubFromGh = true;
    else if (arg === '--verbose') verbose = true;
    else if (arg === '--help' || arg === '-h' || arg === 'help') {
      process.stdout.write(HELP);
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}\n\n${HELP}`);
  }
  home = isAbsolute(home) ? home : resolve(home);
  return { command, home, host, port, open, yes, githubFromGh, verbose, file };
}

/**
 * Sub-command arguments belong to the sub-parser, but the connection flags stay
 * with the CLI: both parsers reject what they do not know, so the split has to
 * happen before either runs.
 */
function splitClientArgs(argv: readonly string[]): { cli: string[]; rest: string[] } {
  const cli: string[] = [];
  const rest: string[] = [];
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--home' || arg === '--host' || arg === '--port') cli.push(arg, requiredValue(argv, ++i, arg));
    else rest.push(arg);
  }
  return { cli, rest };
}

function requiredValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index];
  if (!value || value.startsWith('-')) throw new Error(`${option} requires a value.`);
  return value;
}

function validPort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid port: ${value}`);
  return port;
}

function resolveAddress(options: CliOptions): { host: string; port: number } {
  const stored = readStoredAddress(options.home);
  return {
    host: options.host ?? process.env.COMPANION_HOST?.trim() ?? stored.host ?? '127.0.0.1',
    port: options.port ?? envPort(process.env.COMPANION_PORT) ?? stored.port ?? 8901,
  };
}

function readStoredAddress(home: string): { host?: string; port?: number } {
  const file = join(home, 'companiond.json');
  if (!existsSync(file)) return {};
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as { host?: unknown; port?: unknown };
    return {
      host: typeof value.host === 'string' && value.host.trim() ? value.host : undefined,
      port: typeof value.port === 'number' && Number.isInteger(value.port) ? value.port : undefined,
    };
  } catch {
    return {};
  }
}

function envPort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  try {
    return validPort(value);
  } catch {
    return undefined;
  }
}

function localUrl(host: string, port: number): string {
  const browserHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const formattedHost = browserHost.includes(':') ? `[${browserHost}]` : browserHost;
  return `http://${formattedHost}:${port}`;
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return true;
    } catch {
      // Boot is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.once('error', () => process.stderr.write(`Could not open a browser automatically. Open ${url}\n`));
  child.unref();
}

main().catch((err: unknown) => {
  if (err instanceof SetupCancelled || (err instanceof Error && err.name === 'ExitPromptError')) {
    process.stderr.write('Setup cancelled.\n');
    process.exit(130);
  }
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
