import type { AclExplained, AclMap, RoleDetail, RoleRecord } from '@companion/module-core/contract';
import { apiClient } from './client.js';

export const ACL_HELP = `Usage: companion acl <command> [options]
       companion role <command> [options]

  acl map [--by role|module|permission] [--role <id>]
                             The grid the running daemon computes right now
  acl explain <user|role> <permission>
                             Why that subject does or does not hold it
  role list                  Roles and how many permissions each holds
  role show <id>             One role's permissions, grouped by owning module
  role create <id> --title "..." [--from <role>] [--description "..."]
  role delete <id>
  role grant  <id> <permission>...
  role revoke <id> <permission>...
  role reset  <id> <permission>...   Drop the override; fall back to module grants
  role repair --grant-admin <user>   OFFLINE lockout recovery (daemon stopped)
  user role <username> <role>        Assign a role to an account

Options:
  --json                     Machine-readable output
  --home <path>              Data directory (default: COMPANION_HOME or ~/.companion)
  --host <host> --port <n>   Address of the running daemon

The grid reflects the ENABLED modules: a disabled module's permissions are gone
from it. That is the difference between this and reading acl.ts in the repo.
`;

export interface AclCommand {
  readonly group: 'acl' | 'role' | 'user';
  readonly action:
    | 'map'
    | 'explain'
    | 'list'
    | 'show'
    | 'create'
    | 'delete'
    | 'grant'
    | 'revoke'
    | 'reset'
    | 'repair'
    | 'role';
  readonly args: readonly string[];
  readonly by: 'role' | 'module' | 'permission';
  readonly role?: string;
  readonly title?: string;
  readonly description?: string;
  readonly from?: string;
  readonly grantAdmin?: string;
  readonly home: string;
  readonly json: boolean;
}

const VALUE_FLAGS = ['--by', '--role', '--title', '--description', '--from', '--grant-admin'];

const ACTIONS = {
  acl: ['map', 'explain'],
  role: ['list', 'show', 'create', 'delete', 'grant', 'revoke', 'reset', 'repair'],
  user: ['role'],
} as const;

export function parseAclCommand(group: AclCommand['group'], argv: readonly string[], home: string): AclCommand {
  const action = argv[0] as AclCommand['action'];
  if (!action || !(ACTIONS[group] as readonly string[]).includes(action)) {
    throw new Error(`Unknown ${group} command: ${action ?? '(none)'}\n\n${ACL_HELP}`);
  }
  const args: string[] = [];
  let by: AclCommand['by'] = 'role';
  let role: string | undefined;
  let title: string | undefined;
  let description: string | undefined;
  let from: string | undefined;
  let grantAdmin: string | undefined;
  let json = false;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--json') json = true;
    else if (VALUE_FLAGS.includes(arg)) {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value.`);
      if (arg === '--role') role = value;
      else if (arg === '--title') title = value;
      else if (arg === '--description') description = value;
      else if (arg === '--from') from = value;
      else if (arg === '--grant-admin') grantAdmin = value;
      else {
        if (!['role', 'module', 'permission'].includes(value)) throw new Error('--by must be role, module or permission');
        by = value as AclCommand['by'];
      }
    } else if (arg.startsWith('-')) throw new Error(`Unknown argument: ${arg}`);
    else args.push(arg);
  }
  if (action === 'explain' && args.length !== 2) {
    throw new Error('Usage: companion acl explain <user|role> <permission>');
  }
  if (action === 'show' && args.length !== 1) throw new Error('Usage: companion role show <id>');
  if (['create', 'delete'].includes(action) && args.length !== 1) throw new Error(`Usage: companion role ${action} <id>`);
  if (['grant', 'revoke', 'reset'].includes(action) && args.length < 2) {
    throw new Error(`Usage: companion role ${action} <role> <permission>...`);
  }
  if (action === 'create' && !title) throw new Error('--title is required (it is what the role picker shows).');
  if (action === 'repair' && !grantAdmin) throw new Error('Usage: companion role repair --grant-admin <username>');
  if (group === 'user' && args.length !== 2) throw new Error('Usage: companion user role <username> <role>');
  return { group, action, args, by, role, title, description, from, grantAdmin, home, json };
}

export async function runAclCommand(cmd: AclCommand, baseUrl: string): Promise<void> {
  const out = (value: unknown): void => void process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

  // The one command that must work with the daemon DOWN: a lockout can prevent
  // the very route that would fix it from being reachable.
  if (cmd.action === 'repair') {
    // Lazy: this is the only command that touches the native SQLite binding, and
    // every other one should keep working even if that binding is unusable.
    const { repairGrantAdmin } = await import('./repair.js');
    return repairGrantAdmin(cmd.home, cmd.grantAdmin!, baseUrl);
  }

  const api = apiClient(baseUrl);
  if (cmd.group === 'user') {
    const [username, role] = cmd.args as [string, string];
    const { user } = await api<{ user: { username: string; role: string } }>('PATCH', `/api/users/${username}`, { role });
    if (cmd.json) return out(user);
    process.stdout.write(`${user.username} now holds '${user.role}'.\n`);
    return;
  }

  if (cmd.action === 'create') {
    const { role } = await api<{ role: RoleRecord }>('POST', '/api/roles', {
      id: cmd.args[0],
      title: cmd.title,
      description: cmd.description,
      from: cmd.from,
    });
    if (cmd.json) return out(role);
    process.stdout.write(`Created role '${role.id}' (${role.title})`);
    process.stdout.write(cmd.from ? `, cloned from '${cmd.from}'.\n` : ' with no permissions yet.\n');
    return;
  }

  if (cmd.action === 'delete') {
    await api<{ ok: true }>('DELETE', `/api/roles/${cmd.args[0]}`);
    process.stdout.write(`Deleted role '${cmd.args[0]}'.\n`);
    return;
  }

  if (cmd.action === 'grant' || cmd.action === 'revoke' || cmd.action === 'reset') {
    const [id, ...permissions] = cmd.args as [string, ...string[]];
    const { role } = await api<{ role: RoleDetail }>('POST', `/api/roles/${id}/permissions`, {
      mode: cmd.action,
      permissions,
    });
    if (cmd.json) return out(role);
    process.stdout.write(`${cmd.action} ${permissions.join(', ')} on '${id}'.\n`);
    return printRoleDetail(role);
  }

  if (cmd.action === 'explain') {
    const [subject, permission] = cmd.args as [string, string];
    const query = `subject=${encodeURIComponent(subject)}&permission=${encodeURIComponent(permission)}`;
    const result = await api<AclExplained>('GET', `/api/acl/explain?${query}`);
    return cmd.json ? out(result) : printExplain(subject, result);
  }

  const map = await api<AclMap>('GET', '/api/acl');
  if (cmd.json) return out(cmd.action === 'list' || cmd.action === 'show' ? map.roles : map);

  if (cmd.action === 'list') {
    const { roles } = await api<{ roles: RoleRecord[] }>('GET', '/api/roles');
    const width = Math.max(...roles.map((r) => r.id.length));
    for (const r of roles) {
      const held = map.roles.find((x) => x.id === r.id)?.permissions.length ?? 0;
      process.stdout.write(`${r.id.padEnd(width)}  ${String(held).padStart(3)} perms  ${r.builtin ? 'built-in' : 'custom  '}  ${r.title}\n`);
    }
    return;
  }
  if (cmd.action === 'show') {
    const { role } = await api<{ role: RoleDetail }>('GET', `/api/roles/${cmd.args[0]}`);
    return printRoleDetail(role);
  }
  if (cmd.by === 'permission') return printByPermission(map, cmd.role);
  if (cmd.by === 'module') return printByModule(map);
  for (const role of map.roles) {
    if (cmd.role && role.id !== cmd.role) continue;
    printRole(map, role.id);
  }
}

/** A role with its instance overrides called out: those are what an admin edited. */
function printRoleDetail(role: RoleDetail): void {
  process.stdout.write(`\n${role.id}  ${role.builtin ? '(built-in)' : '(custom)'}  ${role.title}\n`);
  if (role.description) process.stdout.write(`  ${role.description}\n`);
  process.stdout.write(`  ${role.permissions.length} effective permission(s), ${role.userCount} user(s)\n`);
  for (const p of role.permissions) {
    const o = role.overrides.find((x) => x.permission === p);
    process.stdout.write(`    ${p}${o ? `  [${o.mode}ed here]` : ''}\n`);
  }
  const revoked = role.overrides.filter((o) => o.mode === 'revoke');
  for (const o of revoked) process.stdout.write(`    ${o.permission}  [REVOKED here]\n`);
  process.stdout.write('\n');
}

// ---------------------------------------------------------------- output

const ownerOf = (map: AclMap, id: string): string => map.permissions.find((p) => p.id === id)?.owner ?? '(unowned)';

function printRole(map: AclMap, roleId: string): void {
  const role = map.roles.find((r) => r.id === roleId);
  if (!role) throw new Error(`Unknown role: ${roleId}. Known: ${map.roles.map((r) => r.id).join(', ')}`);
  process.stdout.write(`\n${role.id}  (${role.permissions.length} permissions)\n`);
  const byOwner = new Map<string, string[]>();
  for (const id of role.permissions) {
    const owner = ownerOf(map, id);
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), id]);
  }
  for (const [owner, ids] of [...byOwner].sort()) process.stdout.write(`  ${owner.padEnd(12)} ${ids.join(', ')}\n`);
  process.stdout.write('\n');
}

function printByPermission(map: AclMap, only?: string): void {
  const width = Math.max(...map.permissions.map((p) => p.id.length));
  for (const p of map.permissions) {
    const grants = only ? p.grants.filter((g) => g === only) : p.grants;
    if (only && !grants.length) continue;
    process.stdout.write(`${p.id.padEnd(width)}  ${p.owner.padEnd(12)}  ${grants.join(', ') || '(no role)'}\n`);
  }
}

function printByModule(map: AclMap): void {
  const owners = [...new Set(map.permissions.map((p) => p.owner))].sort();
  for (const owner of owners) {
    const owned = map.permissions.filter((p) => p.owner === owner);
    process.stdout.write(`\n${owner}  (owns ${owned.length})\n`);
    const width = Math.max(...owned.map((p) => p.id.length));
    for (const p of owned) process.stdout.write(`  ${p.id.padEnd(width)}  ${p.grants.join(', ') || '(no role)'}\n`);
  }
  process.stdout.write('\n');
}

/** Support-facing: name the mechanism, not just the verdict. */
function printExplain(subject: string, r: AclExplained): void {
  process.stdout.write(`${r.granted ? 'GRANTED' : 'DENIED'}  ${subject} -> ${r.permission}\n`);
  const who = r.username ? `user '${r.username}' has role '${r.role}'` : `role '${r.role}'`;
  process.stdout.write(`  ${who}\n`);
  if (!r.owner) {
    process.stdout.write(`  no module in this build declares '${r.permission}' (typo?)\n`);
    return;
  }
  if (!r.ownerEnabled) {
    const state = r.ownerInstalled ? 'installed but DISABLED' : 'NOT installed';
    process.stdout.write(`  declared by module '${r.owner}', which is ${state}\n`);
    process.stdout.write(`  hint: companion module ${r.ownerInstalled ? 'enable' : 'install'} ${r.owner}\n`);
    return;
  }
  process.stdout.write(`  owned by module '${r.owner}' (enabled): ${r.title}\n`);
  for (const g of r.grantedBy) {
    const how = g.kind === 'wildcard' ? `grants.${r.role} = '*'` : `grants.${r.role} lists it`;
    process.stdout.write(`  granted by module '${g.module}' acl.ts, ${how}\n`);
  }
  for (const implied of r.impliedBy) process.stdout.write(`  implied by '${implied}', which this role holds\n`);

  // The override is the whole answer whenever it exists: it is why the module
  // grant printed above did not decide the outcome.
  if (r.override) {
    const verb = r.override === 'grant' ? 'GRANTED' : 'REVOKED';
    process.stdout.write(`  ${verb} by an instance override, which beats every module grant\n`);
    process.stdout.write(`  hint: companion role reset ${r.role} ${r.permission}\n`);
    return;
  }
  if (r.granted) return;
  process.stdout.write(
    r.grantedBy.length
      ? `  no instance override, so the module grant above should apply: this is a bug, please report it\n`
      : `  nothing grants it to '${r.role}', and nothing this role holds implies it\n`,
  );
  process.stdout.write(`  hint: companion role grant ${r.role} ${r.permission}\n`);
}
