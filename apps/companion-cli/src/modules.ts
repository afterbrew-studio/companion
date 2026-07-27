import type { ModuleConfigField, ModuleConfigState, ModuleConfigValue } from '@companion/core';
import type { ModuleListing } from '@companion/core/server';
import { paths } from '@companion/services';
import { apiClient } from './client.js';
import { installedModuleDirs, verifyModuleDir } from './verify.js';

export const MODULE_HELP = `Usage: companion module <command> [options]

  list                       Every module in this build and its state
  info <id>                  One module: state, dependencies, permissions, config spec
  enable <id>                Start a module that is installed but off
  disable <id>               Stop a module, keeping its tables and configuration
  install <id> [--set k=v]   Adopt an Available module (runs its migrations)
  uninstall <id> [--yes]     Roll back its migrations and wipe its configuration
  config <id> [--set k=v] [--unset k]
                             Show or change a module's configuration
  verify [dir]               Static ABI check on an out-of-tree module. With no
                             argument, checks every module installed in <home>/modules.

Options:
  --yes                      Skip the uninstall confirmation (required when piped)
  --json                     Machine-readable output
  --home <path>              Data directory (default: COMPANION_HOME or ~/.companion)
  --host <host> --port <n>   Address of the running daemon

Companion must be running. Commands authenticate with the token in
<home>/cli-token, which the daemon mints at boot.
`;

/** `--set a=b --set c=d` in argv order; a repeated key keeps the last value. */
export interface ModuleCommand {
  readonly action: 'list' | 'info' | 'enable' | 'disable' | 'install' | 'uninstall' | 'config' | 'verify';
  readonly id?: string;
  readonly set: readonly (readonly [string, string])[];
  readonly unset: readonly string[];
  readonly json: boolean;
  readonly yes: boolean;
}

const ACTIONS = ['list', 'info', 'enable', 'disable', 'install', 'uninstall', 'config', 'verify'] as const;

export function parseModuleCommand(argv: readonly string[]): ModuleCommand {
  const action = argv[0] as ModuleCommand['action'];
  if (!action || !ACTIONS.includes(action)) {
    throw new Error(`Unknown module command: ${action ?? '(none)'}\n\n${MODULE_HELP}`);
  }
  const set: [string, string][] = [];
  const unset: string[] = [];
  let id: string | undefined;
  let json = false;
  let yes = false;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--yes' || arg === '-y') yes = true;
    else if (arg === '--set' || arg === '--unset') {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value.`);
      if (arg === '--unset') unset.push(value);
      else {
        const eq = value.indexOf('=');
        if (eq < 1) throw new Error(`--set expects key=value, got: ${value}`);
        set.push([value.slice(0, eq), value.slice(eq + 1)]);
      }
    } else if (arg.startsWith('-')) throw new Error(`Unknown argument: ${arg}`);
    else if (id === undefined) id = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  // `verify` takes an optional path, not an id: it runs against files on disk,
  // with no daemon involved.
  if (action !== 'list' && action !== 'verify' && !id) {
    throw new Error(`companion module ${action} requires a module id.`);
  }
  return { action, id, set, unset, json, yes };
}

export async function runModuleCommand(cmd: ModuleCommand, baseUrl: string): Promise<void> {
  const api = apiClient(baseUrl);
  const out = (value: unknown): void => void process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

  // Before the daemon call, because verify deliberately needs no daemon: an
  // author checks a build on a laptop that has never run Companion.
  if (cmd.action === 'verify') return runVerify(cmd);

  if (cmd.action === 'list') {
    const { modules } = await api<{ modules: ModuleListing[] }>('GET', '/api/modules');
    return cmd.json ? out(modules) : printList(modules);
  }

  const id = cmd.id!;
  const find = (modules: readonly ModuleListing[]): ModuleListing => {
    const found = modules.find((m) => m.id === id);
    if (!found) throw new Error(`Unknown module: ${id}. Run \`companion module list\`.`);
    return found;
  };

  if (cmd.action === 'info') {
    const { modules } = await api<{ modules: ModuleListing[] }>('GET', '/api/modules');
    const mod = find(modules);
    if (cmd.json) return out(mod);
    return printInfo(mod, mod.config.length ? await api<ModuleConfigState>('GET', `/api/modules/${id}/config`) : null);
  }

  if (cmd.action === 'config') {
    const { modules } = await api<{ modules: ModuleListing[] }>('GET', '/api/modules');
    const mod = find(modules);
    if (!cmd.set.length && !cmd.unset.length) {
      const state = await api<ModuleConfigState>('GET', `/api/modules/${id}/config`);
      return cmd.json ? out(state) : printConfig(mod, state);
    }
    const patch = buildPatch(mod, cmd);
    const state = await api<ModuleConfigState>('PUT', `/api/modules/${id}/config`, { config: patch });
    if (cmd.json) return out(state);
    process.stdout.write(`Updated ${Object.keys(patch).length} setting(s) on ${id}.\n\n`);
    return printConfig(mod, state);
  }

  if (cmd.action === 'install') {
    const { modules } = await api<{ modules: ModuleListing[] }>('GET', '/api/modules');
    const mod = find(modules);
    const config = cmd.set.length ? buildPatch(mod, cmd) : undefined;
    const result = await api<{ modules: ModuleListing[] }>('POST', `/api/modules/${id}/install`, { config });
    return cmd.json ? out(result.modules) : printTransition(id, 'installed', result.modules);
  }

  if (cmd.action === 'uninstall' && !(await confirmUninstall(id, cmd))) {
    process.stdout.write('Cancelled.\n');
    return;
  }
  const past = { enable: 'enabled', disable: 'disabled', uninstall: 'uninstalled' } as const;
  const result = await api<{ modules: ModuleListing[] }>('POST', `/api/modules/${id}/${cmd.action}`);
  return cmd.json ? out(result.modules) : printTransition(id, past[cmd.action], result.modules);
}

// ---------------------------------------------------------------- destructive ops

/**
 * `uninstall` walks the module's `down()` migrations to zero (or calls its
 * `purge()`), clears the migration ledger and deletes its stored config. The
 * rollback is not optional and there is no backup, so the confirmation is the
 * only thing between a typo and lost data. `disable` is the reversible verb.
 */
async function confirmUninstall(id: string, cmd: ModuleCommand): Promise<boolean> {
  if (cmd.yes) return true;
  process.stdout.write(
    `Uninstalling ${id} rolls back its migrations (dropping its tables) and wipes its\n` +
      `configuration. The data is not recoverable.\n` +
      `To stop it and keep everything, run instead: companion module disable ${id}\n\n`,
  );
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Refusing to uninstall without a terminal to confirm on. Pass --yes if you are sure.');
  }
  const { confirm } = await import('@inquirer/prompts');
  return confirm({ message: `Uninstall ${id} and delete its data?`, default: false });
}

// ---------------------------------------------------------------- values

/**
 * `--set` values arrive as strings; the daemon validates against the declared
 * kind and would reject "3" for a number field. Coerce with the module's own
 * spec so the CLI and the admin form accept the same input.
 */
function buildPatch(mod: ModuleListing, cmd: ModuleCommand): Record<string, ModuleConfigValue | null> {
  const spec = new Map(mod.config.map((f) => [f.key, f]));
  const patch: Record<string, ModuleConfigValue | null> = {};
  for (const key of cmd.unset) {
    if (!spec.has(key)) throw new Error(unknownKey(mod, key));
    patch[key] = null;
  }
  for (const [key, raw] of cmd.set) {
    const field = spec.get(key);
    if (!field) throw new Error(unknownKey(mod, key));
    patch[key] = coerce(field, raw);
  }
  return patch;
}

function coerce(field: ModuleConfigField, raw: string): ModuleConfigValue {
  if (field.kind === 'number') {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${field.key} expects a number, got: ${raw}`);
    return value;
  }
  if (field.kind === 'boolean') {
    if (['true', '1', 'yes', 'on'].includes(raw)) return true;
    if (['false', '0', 'no', 'off'].includes(raw)) return false;
    throw new Error(`${field.key} expects true or false, got: ${raw}`);
  }
  return raw;
}

const unknownKey = (mod: ModuleListing, key: string): string =>
  `${mod.id} has no setting '${key}'.` +
  (mod.config.length ? ` Known: ${mod.config.map((f) => f.key).join(', ')}` : ' It declares no configuration.');

// ---------------------------------------------------------------- output

/** enabled / disabled / available, plus the one state that needs an action. */
function state(m: ModuleListing): string {
  if (!m.installed) return 'available';
  if (!m.configured) return 'needs config';
  return m.enabled ? 'enabled' : 'disabled';
}

function printList(modules: readonly ModuleListing[]): void {
  const rows = modules.map((m) => [m.id, state(m) + (m.required ? ' (required)' : ''), m.version, m.title]);
  const width = (i: number): number => Math.max(...rows.map((r) => r[i]!.length));
  for (const row of rows) {
    process.stdout.write(`${row[0]!.padEnd(width(0))}  ${row[1]!.padEnd(width(1))}  ${row[2]!.padEnd(width(2))}  ${row[3]}\n`);
  }
  const enabled = modules.filter((m) => m.enabled).length;
  process.stdout.write(`\n${enabled} of ${modules.length} enabled.\n`);
}

function printInfo(m: ModuleListing, config: ModuleConfigState | null): void {
  process.stdout.write(`${m.title} (${m.id})  ${m.version}\n`);
  process.stdout.write(`  state        ${state(m)}${m.required ? ' (cannot be disabled)' : ''}\n`);
  process.stdout.write(`  depends on   ${m.dependsOn.length ? m.dependsOn.join(', ') : '(nothing)'}\n`);
  process.stdout.write(`  permissions  ${m.permissions.length ? m.permissions.join(', ') : '(none)'}\n`);
  if (config) {
    process.stdout.write('\n');
    printConfig(m, config);
  }
}

function printConfig(m: ModuleListing, state: ModuleConfigState): void {
  if (!m.config.length) return void process.stdout.write(`${m.id} declares no configuration.\n`);
  const width = Math.max(...m.config.map((f) => f.key.length));
  for (const field of m.config) {
    // Secret values never leave the daemon, only their set/unset state does.
    const value =
      field.kind === 'secret'
        ? state.secrets[field.key]
          ? '(set)'
          : '(not set)'
        : (state.values[field.key] ?? field.default ?? '(not set)');
    const notes = [field.kind, field.required ? 'required' : null].filter(Boolean).join(', ');
    process.stdout.write(`  ${field.key.padEnd(width)}  ${String(value).padEnd(12)}  ${field.label} [${notes}]\n`);
  }
}

function printTransition(id: string, verb: string, modules: readonly ModuleListing[]): void {
  const mod = modules.find((m) => m.id === id);
  process.stdout.write(`${id} ${verb}.\n`);
  if (mod) process.stdout.write(`State: ${state(mod)}.\n`);
}

/**
 * Static ABI check. Runs against files, never against a daemon: an author must
 * be able to check a build before installing it anywhere.
 */
function runVerify(cmd: ModuleCommand): void {
  const dirs = cmd.id ? [cmd.id] : installedModuleDirs(paths.externalModules());
  if (!dirs.length) {
    process.stdout.write(`No out-of-tree modules in ${paths.externalModules()}.\n`);
    return;
  }
  const results = dirs.map((dir) => ({ dir, ...verifyModuleDir(dir) }));
  if (cmd.json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } else {
    for (const r of results) {
      process.stdout.write(`\n${r.dir}\n  ${r.ok ? 'OK' : 'FAILED'}\n`);
      for (const n of r.notes) process.stdout.write(`    - ${n}\n`);
      for (const p of r.problems) process.stdout.write(`    ! ${p}\n`);
    }
    process.stdout.write('\n');
  }
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}
