#!/usr/bin/env node
/**
 * ACL tooling for the Companion module set.
 *
 *   node scripts/acl.mjs map   [--by role|module|permission] [--role <id>]
 *                             [--modules a,b,c] [--json]
 *   node scripts/acl.mjs check [--strict] [--json]
 *   node scripts/acl.mjs add   <module> <permission> --title "..."
 *                             [--grant admin,maintainer] [--implies a,b]
 *   node scripts/acl.mjs sync  [--dry]
 *
 * `map` and `check` read each module's BUILT acl (`dist/api/acl.js`) and fold it
 * with the kernel's own `buildRolePermissions`, so the grid printed here is the
 * grid the daemon computes rather than a re-implementation. Run `pnpm -r build`
 * first; a stale `dist` is detected and refused rather than silently trusted.
 *
 * `add` and `sync` write the two DERIVED declaration sites (the manifest's
 * `permissions` array and the contract's `PermissionRegistry`) from `acl.ts`,
 * which is the single authored source.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const modulesDir = join(root, 'modules');
const ID_RE = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;

/**
 * The committed effective grid. Its only job is to put "this change alters who
 * may do what" into the PR diff, where a reviewer sees it. Deliberately excludes
 * the usage sites, which would churn on every file move without saying anything
 * about capability.
 */
const SNAPSHOT_FILE = join(root, 'docs/acl-grid.json');

function gridSnapshot(mods, grid, roles) {
  const owner = new Map();
  const titles = new Map();
  for (const m of mods) {
    for (const p of m.acl?.permissions ?? []) {
      owner.set(p.id, m.id);
      titles.set(p.id, p.title);
    }
  }
  const permissions = {};
  for (const id of [...owner.keys()].sort()) {
    permissions[id] = { owner: owner.get(id), title: titles.get(id), grants: roles.filter((r) => grid[r].has(id)) };
  }
  return `${JSON.stringify({ roles: Object.fromEntries(roles.map((r) => [r, [...grid[r]].sort()])), permissions }, null, 2)}\n`;
}

const USAGE = `usage: acl <command> [options]

  map    [--by role|module|permission] [--role <id>] [--modules a,b,c] [--json]
  check  [--strict] [--json]
  add    <module> <permission> --title "..." [--grant a,b] [--implies a,b]
  sync   [--dry]

This reads the REPO, so it shows what MODULES grant the three built-in roles.
Custom roles and instance grant overrides are database state: use
"companion acl map --live", "companion acl explain" and "companion role ..."
against a running daemon. See docs/acl-and-roles.md.
`;

// ---------------------------------------------------------------- loading

/** Body of `interface <name> { ... }`, brace-counted so nested object types survive. */
function interfaceBody(src, name) {
  const head = src.indexOf(`interface ${name}`);
  if (head === -1) return null;
  const open = src.indexOf('{', head);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

const quotedKeys = (body) => [...body.matchAll(/'([^']+)'\s*:/g)].map((m) => m[1]);
const bareKeys = (body) => [...body.matchAll(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*[?]?:/gm)].map((m) => m[1]);

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

/**
 * Permission ids as written in `acl.ts` SOURCE. Compared against the built acl
 * so a stale `dist` is caught before anything is derived from it.
 */
function sourceAclIds(file) {
  if (!existsSync(file)) return [];
  return [...readFileSync(file, 'utf8').matchAll(/\{\s*id:\s*'([^']+)'/g)].map((m) => m[1]);
}

async function loadModules() {
  const ids = readdirSync(modulesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(modulesDir, e.name, 'src/module.ts')))
    .map((e) => e.name)
    .sort();

  const mods = [];
  for (const id of ids) {
    const dir = join(modulesDir, id);
    const manifestDist = join(dir, 'dist/module.js');
    if (!existsSync(manifestDist)) fail(`modules/${id}/dist is missing. Run: pnpm -r build`);
    const manifest = (await import(pathToFileURL(manifestDist).href)).default;

    const aclSrc = join(dir, 'src/api/acl.ts');
    const aclDist = join(dir, 'dist/api/acl.js');
    let acl = null;
    if (existsSync(aclSrc)) {
      if (!existsSync(aclDist)) fail(`modules/${id}/dist/api/acl.js is missing. Run: pnpm -r build`);
      acl = (await import(pathToFileURL(aclDist).href)).default;
      const built = acl.permissions.map((p) => p.id).join('|');
      const written = sourceAclIds(aclSrc).join('|');
      if (built !== written) fail(`modules/${id}: dist/api/acl.js is stale (acl.ts was edited). Run: pnpm -r build`);
    }

    const contractSrc = join(dir, 'src/contract/index.ts');
    const contract = existsSync(contractSrc) ? readFileSync(contractSrc, 'utf8') : '';
    const permBody = interfaceBody(contract, 'PermissionRegistry');
    const svcBody = interfaceBody(contract, 'ServiceMap');

    mods.push({
      id,
      dir,
      manifest,
      acl,
      contractPermissions: permBody ? quotedKeys(permBody) : [],
      services: svcBody ? bareKeys(svcBody) : [],
      sources: walk(join(dir, 'src')).filter((f) => /\.tsx?$/.test(f)),
    });
  }
  return mods;
}

/**
 * Every site that gates on a permission:
 *  - `access:` on a route,
 *  - `permission:` on nav / client routes / slots,
 *  - `rbac.has(role, 'x')` and `can('x')`, the PROGRAMMATIC checks. Missing
 *    these is what made the checker call `runners:manage` dead when it is in
 *    fact what separates a shared runner from a personal one,
 *  - `need:` in onboarding files ONLY: the GitHub client resolver uses the same
 *    key for a repo permission (pull/push/admin), so matching it everywhere
 *    would report GitHub scopes as Companion permissions.
 */
function scanUsage(mods) {
  const uses = [];
  for (const m of mods) {
    for (const file of m.sources) {
      const src = readFileSync(file, 'utf8');
      const rel = file.slice(root.length + 1);
      const add = (permission, kind) => uses.push({ module: m.id, permission, kind, at: rel });
      for (const [, p] of src.matchAll(/\baccess:\s*'([^']+)'/g)) {
        if (p !== 'public' && p !== 'any') add(p, 'route');
      }
      for (const [, p] of src.matchAll(/\bpermission:\s*'([^']+)'/g)) add(p, 'ui');
      for (const [, p] of src.matchAll(/\.has\([^,)]+,\s*'([^']+)'\)/g)) add(p, 'rbac-check');
      for (const [, p] of src.matchAll(/\bcan\('([^']+)'\)/g)) add(p, 'can');
      if (/onboarding/.test(rel)) for (const [, p] of src.matchAll(/\bneed:\s*'([^']+)'/g)) add(p, 'onboarding');
    }
  }
  return uses;
}

/**
 * Route identities for collision detection. Deliberately conservative: it only
 * matches `method` immediately followed by `path`, so it under-reports rather
 * than inventing conflicts.
 */
function scanRoutes(mods) {
  const out = [];
  for (const m of mods) {
    for (const file of m.sources.filter((f) => /routes\.tsx?$/.test(f))) {
      const src = readFileSync(file, 'utf8');
      for (const [, method, path] of src.matchAll(/method:\s*'([A-Z]+)'\s*,\s*path:\s*'([^']+)'/g)) {
        out.push({ module: m.id, key: `${method} ${path}`, at: file.slice(root.length + 1) });
      }
    }
  }
  return out;
}

/**
 * Nav identities that must be unique across the whole catalog, not just the
 * enabled set: a shortcut only collides once both owners are installed, and the
 * shell has no way to arbitrate. `field` distinguishes the two kinds so the
 * error names what actually clashed.
 */
function scanNav(mods, field) {
  const pattern = new RegExp(`^\\s*${field}:\\s*'([^']+)'`, 'gm');
  const out = [];
  for (const m of mods) {
    for (const file of m.sources.filter((f) => /nav\.tsx?$/.test(f))) {
      const src = readFileSync(file, 'utf8');
      for (const [, value] of src.matchAll(pattern)) {
        out.push({ module: m.id, key: value, at: file.slice(root.length + 1) });
      }
    }
  }
  return out;
}

/** Transitive `dependsOn` closure, so a foreign permission can be judged reachable. */
function closure(mods, id, seen = new Set()) {
  for (const dep of mods.find((m) => m.id === id)?.manifest.dependsOn ?? []) {
    if (seen.has(dep)) continue;
    seen.add(dep);
    closure(mods, dep, seen);
  }
  return seen;
}

// ---------------------------------------------------------------- map

async function buildGrid(mods) {
  const { buildRolePermissions } = await import(pathToFileURL(join(root, 'packages/contracts/dist/rbac.js')).href);
  const { BUILTIN_ROLES } = await import(pathToFileURL(join(root, 'packages/types/dist/roles.js')).href);
  // Built-ins only, deliberately: this tool reads the REPO, where the only
  // grants that exist are the modules'. Custom roles and instance overrides live
  // in a running daemon's database — `companion acl map --live` shows those.
  return { grid: buildRolePermissions(mods.map((m) => m.acl).filter(Boolean)), roles: BUILTIN_ROLES };
}

function aclMap(mods, grid, roles, uses) {
  const permissions = {};
  for (const m of mods) {
    for (const p of m.acl?.permissions ?? []) {
      permissions[p.id] = {
        owner: m.id,
        title: p.title,
        implies: [...(p.implies ?? [])],
        grants: roles.filter((r) => grid[r].has(p.id)),
        usedBy: uses.filter((u) => u.permission === p.id).map((u) => ({ module: u.module, kind: u.kind, at: u.at })),
      };
    }
  }
  return {
    version: 1,
    generatedFrom: mods.map((m) => m.id),
    roles: Object.fromEntries(roles.map((r) => [r, { builtin: true, permissions: [...grid[r]].sort() }])),
    permissions,
    modules: Object.fromEntries(
      mods.map((m) => {
        const owned = new Set((m.acl?.permissions ?? []).map((p) => p.id));
        return [
          m.id,
          {
            owns: [...owned].sort(),
            consumes: [...new Set(uses.filter((u) => u.module === m.id && !owned.has(u.permission)).map((u) => u.permission))].sort(),
          },
        ];
      }),
    ),
  };
}

async function cmdMap(opts) {
  let mods = await loadModules();
  if (opts.modules) {
    const want = new Set(opts.modules.split(','));
    mods = mods.filter((m) => want.has(m.id));
    const missing = [...want].filter((w) => !mods.some((m) => m.id === w));
    if (missing.length) fail(`unknown module(s): ${missing.join(', ')}`);
  }
  const { grid, roles } = await buildGrid(mods);
  const uses = scanUsage(mods);
  const map = aclMap(mods, grid, roles, uses);

  if (opts.json) return void process.stdout.write(`${JSON.stringify(map, null, 2)}\n`);

  const shown = opts.role ? [opts.role] : roles;
  for (const r of shown) {
    if (!map.roles[r]) fail(`unknown role: ${r} (built-ins: ${roles.join(', ')})`);
  }

  if (opts.by === 'permission') {
    const width = Math.max(...Object.keys(map.permissions).map((p) => p.length));
    for (const [id, p] of Object.entries(map.permissions).sort()) {
      const held = shown.filter((r) => p.grants.includes(r));
      process.stdout.write(`${id.padEnd(width)}  ${p.owner.padEnd(12)}  ${held.join(', ') || '(no role)'}\n`);
    }
    return;
  }

  if (opts.by === 'module') {
    for (const m of mods) {
      const info = map.modules[m.id];
      process.stdout.write(`\n${m.id}  (owns ${info.owns.length})\n`);
      for (const id of info.owns) {
        const p = map.permissions[id];
        process.stdout.write(`  ${id.padEnd(22)} ${p.grants.join(', ') || '(no role)'}\n`);
      }
      if (info.consumes.length) process.stdout.write(`  consumes: ${info.consumes.join(', ')}\n`);
    }
    process.stdout.write('\n');
    return;
  }

  for (const r of shown) {
    const perms = map.roles[r].permissions;
    process.stdout.write(`\n${r}  (${perms.length} permission${perms.length === 1 ? '' : 's'})\n`);
    const byOwner = new Map();
    for (const id of perms) {
      const owner = map.permissions[id]?.owner ?? '(unowned)';
      byOwner.set(owner, [...(byOwner.get(owner) ?? []), id]);
    }
    for (const [owner, ids] of [...byOwner].sort()) {
      process.stdout.write(`  ${owner.padEnd(12)} ${ids.join(', ')}\n`);
    }
  }
  process.stdout.write('\n');
}

// ---------------------------------------------------------------- check

async function cmdCheck(opts) {
  const mods = await loadModules();
  const { grid, roles } = await buildGrid(mods);
  const uses = scanUsage(mods);
  const findings = [];
  const error = (rule, message) => findings.push({ level: 'ERROR', rule, message });
  const warn = (rule, message) => findings.push({ level: 'WARN', rule, message });

  const owner = new Map();
  for (const m of mods) {
    for (const p of m.acl?.permissions ?? []) {
      const prev = owner.get(p.id);
      if (prev) error('duplicate-permission', `'${p.id}' declared by both ${prev} and ${m.id}`);
      else owner.set(p.id, m.id);
    }
  }

  const seenMessage = new Map();
  for (const m of mods) {
    for (const t of m.manifest.messages ?? []) {
      const prev = seenMessage.get(t);
      if (prev) error('duplicate-message', `WS message '${t}' declared by both ${prev} and ${m.id}`);
      else seenMessage.set(t, m.id);
    }
  }

  const seenService = new Map();
  for (const m of mods) {
    for (const s of m.services) {
      const prev = seenService.get(s);
      if (prev) error('duplicate-service', `ServiceMap key '${s}' declared by both ${prev} and ${m.id}`);
      else seenService.set(s, m.id);
    }
  }

  const seenRoute = new Map();
  for (const r of scanRoutes(mods)) {
    const prev = seenRoute.get(r.key);
    if (prev && prev.module !== r.module) error('duplicate-route', `${r.key} mounted by both ${prev.module} and ${r.module}`);
    else if (!prev) seenRoute.set(r.key, r);
  }

  for (const [field, rule] of [
    ['key', 'duplicate-nav-key'],
    ['shortcut', 'duplicate-nav-shortcut'],
  ]) {
    const seen = new Map();
    for (const n of scanNav(mods, field)) {
      const prev = seen.get(n.key);
      if (prev) error(rule, `nav ${field} '${n.key}' claimed by both ${prev} and ${n.module}`);
      else seen.set(n.key, n.module);
    }
  }

  for (const m of mods) {
    const declared = (m.acl?.permissions ?? []).map((p) => p.id);
    const inAcl = new Set(declared);
    const inManifest = new Set(m.manifest.permissions ?? []);
    const inContract = new Set(m.contractPermissions);
    const diff = (a, b) => [...a].filter((x) => !b.has(x));
    for (const id of diff(inAcl, inManifest)) error('drift', `${m.id}: '${id}' is in acl.ts but not in the manifest`);
    for (const id of diff(inManifest, inAcl)) error('drift', `${m.id}: '${id}' is in the manifest but not in acl.ts`);
    for (const id of diff(inAcl, inContract)) error('drift', `${m.id}: '${id}' is in acl.ts but not in PermissionRegistry`);
    for (const id of diff(inContract, inAcl)) error('drift', `${m.id}: '${id}' is in PermissionRegistry but not in acl.ts`);

    for (const p of m.acl?.permissions ?? []) {
      for (const imp of p.implies ?? []) {
        if (!owner.has(imp)) error('unknown-implies', `${m.id}: '${p.id}' implies '${imp}', which no module declares`);
      }
    }
    for (const [role, grant] of Object.entries(m.acl?.grants ?? {})) {
      if (grant === '*') continue;
      for (const id of grant) {
        // buildRolePermissions folds a foreign id silently, so a typo here is
        // invisible at runtime: the grant simply never applies to anything.
        if (!inAcl.has(id)) error('foreign-grant', `${m.id}: grants.${role} lists '${id}', which ${m.id} does not declare`);
      }
    }
  }

  for (const u of uses) {
    if (!owner.has(u.permission)) {
      error('undeclared-permission', `${u.at}: '${u.permission}' is gated on but no module declares it`);
      continue;
    }
    const from = owner.get(u.permission);
    if (from === u.module) continue;
    const reachable = closure(mods, u.module);
    const consumes = new Set(mods.find((m) => m.id === u.module)?.manifest.consumes ?? []);
    if (!reachable.has(from) && !consumes.has(u.permission)) {
      warn(
        'foreign-permission',
        `${u.module} gates on '${u.permission}' (owned by ${from}) with no dependsOn edge and no manifest 'consumes' entry`,
      );
    }
  }

  const used = new Set(uses.map((u) => u.permission));
  for (const m of mods) {
    for (const p of m.acl?.permissions ?? []) {
      if (!ID_RE.test(p.id)) error('naming', `${m.id}: '${p.id}' is not <resource>:<verb> (lowercase, dashes allowed)`);
      if (!used.has(p.id) && !mods.some((x) => (x.acl?.permissions ?? []).some((q) => q.implies?.includes(p.id)))) {
        warn('dead-permission', `${m.id}: '${p.id}' is declared but nothing gates on it`);
      }
    }
    for (const id of m.manifest.consumes ?? []) {
      if (!owner.has(id)) error('unknown-consumes', `${m.id}: consumes '${id}', which no module declares`);
      else if (owner.get(id) === m.id) error('self-consumes', `${m.id}: consumes '${id}', which it owns itself`);
      else if (!uses.some((u) => u.module === m.id && u.permission === id)) {
        warn('stale-consumes', `${m.id}: declares consumes '${id}' but no longer gates on it`);
      }
    }
  }

  // The app shell must depend on NO module except the `required: true` ones,
  // or every profile narrower than the shell's import closure stops compiling.
  // This is the check that keeps P5 from regressing one convenient import at a
  // time; the failure it prevents is a build error in a profile nobody runs
  // locally.
  const required = new Set(mods.filter((m) => m.manifest.required).map((m) => m.id));
  for (const file of ['apps/web/src/App.tsx', 'apps/api/src/index.ts']) {
    const full = join(root, file);
    if (!existsSync(full)) continue;
    for (const [, id] of readFileSync(full, 'utf8').matchAll(/@companion\/module-([a-z0-9-]+)/g)) {
      if (!required.has(id)) error('shell-module-import', `${file} imports '@companion/module-${id}', which is not a required module`);
    }
  }

  const snapshot = gridSnapshot(mods, grid, roles);
  const recorded = existsSync(SNAPSHOT_FILE) ? readFileSync(SNAPSHOT_FILE, 'utf8') : null;
  if (recorded === null) warn('missing-snapshot', `${relative(root, SNAPSHOT_FILE)} does not exist. Run: pnpm acl sync`);
  else if (recorded !== snapshot) {
    error('grid-changed', `the effective grid differs from ${relative(root, SNAPSHOT_FILE)}. Run: pnpm acl sync`);
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ findings, roles: Object.fromEntries(roles.map((r) => [r, [...grid[r]].sort()])) }, null, 2)}\n`);
  } else {
    for (const f of findings) process.stdout.write(`${f.level.padEnd(5)}  ${f.rule.padEnd(22)} ${f.message}\n`);
    const errors = findings.filter((f) => f.level === 'ERROR').length;
    const warns = findings.length - errors;
    const perms = mods.reduce((n, m) => n + (m.acl?.permissions.length ?? 0), 0);
    process.stdout.write(
      `${findings.length ? '\n' : ''}${perms} permissions across ${mods.length} modules: ${errors} error(s), ${warns} warning(s)\n`,
    );
  }
  const failed = findings.some((f) => f.level === 'ERROR') || (opts.strict && findings.length > 0);
  if (failed) process.exit(1);
}

// ---------------------------------------------------------------- add / sync

/**
 * Add/remove entries in place, keeping every surviving line byte-identical.
 * Regenerating the block instead would silently drop the doc comments that sit
 * between entries (operate's contract has one) and reformat untouched arrays.
 * Returns null when the id set already matches, so sync never churns.
 */
function reconcileBlock(body, want, idOf, render, fallbackIndent) {
  const present = body.split('\n').map(idOf).filter((id) => id !== null);
  if (present.length === want.length && present.every((id) => want.includes(id))) return null;

  if (!body.includes('\n') && !body.includes('/*')) {
    return want.map((id) => render(id, '').trim().replace(/,$/, '')).join(', ');
  }

  const lines = body.split('\n');
  const kept = [];
  let lastEntry = -1;
  let indent = fallbackIndent;
  for (const line of lines) {
    const id = idOf(line);
    if (id === null) {
      kept.push(line);
      continue;
    }
    if (!want.includes(id)) {
      // Drop the entry's own doc comment with it rather than orphaning it.
      if (/^\s*\/\*\*.*\*\/\s*$/.test(kept[kept.length - 1] ?? '')) kept.pop();
      continue;
    }
    indent = /^\s*/.exec(line)[0];
    lastEntry = kept.push(line) - 1;
  }
  const missing = want.filter((id) => !present.includes(id));
  kept.splice(lastEntry + 1, 0, ...missing.map((id) => render(id, indent)));
  return kept.join('\n');
}

/** Rewrite the two DERIVED declaration sites of one module from its authored `acl.ts` ids. */
function writeDerived(mod, ids, { dry }) {
  const changed = [];
  const apply = (file, next, src) => {
    if (next === src) return;
    changed.push(file);
    if (!dry) writeFileSync(file, next);
  };

  const manifestFile = join(mod.dir, 'src/module.ts');
  const manifest = readFileSync(manifestFile, 'utf8');
  const arrayRe = /(permissions:\s*\[)([\s\S]*?)(\])/;
  const arrayMatch = arrayRe.exec(manifest);
  if (arrayMatch) {
    const body = reconcileBlock(
      arrayMatch[2],
      ids,
      (line) => /^\s*'([^']+)',?\s*$/.exec(line)?.[1] ?? null,
      (id, indent) => `${indent || '    '}'${id}',`,
      '    ',
    );
    if (body !== null) apply(manifestFile, manifest.replace(arrayRe, `$1${body}$3`), manifest);
  } else if (ids.length) {
    const field = `  permissions: [${ids.map((id) => `'${id}'`).join(', ')}],\n`;
    const next = manifest.replace(/\n\}\);?\s*$/, `\n${field}});\n`);
    if (next === manifest) fail(`${mod.id}: could not find the defineManifest({...}) closing brace in module.ts`);
    apply(manifestFile, next, manifest);
  }

  const contractFile = join(mod.dir, 'src/contract/index.ts');
  if (!existsSync(contractFile)) fail(`${mod.id}: src/contract/index.ts is missing`);
  const contract = readFileSync(contractFile, 'utf8');
  const existing = interfaceBody(contract, 'PermissionRegistry');
  if (existing !== null) {
    const body = reconcileBlock(
      existing,
      ids,
      (line) => /^\s*'([^']+)'\s*:\s*true;\s*$/.exec(line)?.[1] ?? null,
      (id, indent) => `${indent || '    '}'${id}': true;`,
      '    ',
    );
    if (body !== null) {
      apply(contractFile, contract.replace(`interface PermissionRegistry {${existing}}`, `interface PermissionRegistry {${body}}`), contract);
    }
  } else if (ids.length) {
    const anchor = /declare module '@companion\/contracts' \{\n/;
    if (!anchor.test(contract)) fail(`${mod.id}: contract has no \`declare module '@moxxy/companion-contracts'\` block`);
    const block = `  interface PermissionRegistry {\n${ids.map((id) => `    '${id}': true;`).join('\n')}\n  }\n`;
    apply(contractFile, contract.replace(anchor, (m) => `${m}${block}`), contract);
  }
  return changed;
}

async function cmdSync(opts) {
  const mods = await loadModules();
  const changed = [];
  for (const m of mods) {
    if (!m.acl) continue;
    changed.push(...writeDerived(m, m.acl.permissions.map((p) => p.id), opts));
  }
  const { grid, roles } = await buildGrid(mods);
  // The app shell must depend on NO module except the `required: true` ones,
  // or every profile narrower than the shell's import closure stops compiling.
  // This is the check that keeps P5 from regressing one convenient import at a
  // time; the failure it prevents is a build error in a profile nobody runs
  // locally.
  const required = new Set(mods.filter((m) => m.manifest.required).map((m) => m.id));
  for (const file of ['apps/web/src/App.tsx', 'apps/api/src/index.ts']) {
    const full = join(root, file);
    if (!existsSync(full)) continue;
    for (const [, id] of readFileSync(full, 'utf8').matchAll(/@companion\/module-([a-z0-9-]+)/g)) {
      if (!required.has(id)) error('shell-module-import', `${file} imports '@companion/module-${id}', which is not a required module`);
    }
  }

  const snapshot = gridSnapshot(mods, grid, roles);
  if (!existsSync(SNAPSHOT_FILE) || readFileSync(SNAPSHOT_FILE, 'utf8') !== snapshot) {
    changed.push(SNAPSHOT_FILE);
    if (!opts.dry) writeFileSync(SNAPSHOT_FILE, snapshot);
  }
  if (!changed.length) return void process.stdout.write('ACL declarations are already in sync.\n');
  for (const f of changed) process.stdout.write(`${opts.dry ? 'would update' : 'updated'}  ${f.slice(root.length + 1)}\n`);
  if (!opts.dry) process.stdout.write('\nRun `pnpm -r build` so dist/ matches the new sources.\n');
}

async function cmdAdd(args, opts) {
  const [moduleId, permission] = args;
  if (!moduleId || !permission) fail('usage: acl add <module> <permission> --title "..." [--grant a,b] [--implies a,b]');
  if (!opts.title) fail('--title is required (it is what the role UI shows instead of the id)');
  if (!/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/.test(permission)) {
    fail(`'${permission}' does not match the <resource>:<verb> convention (e.g. widgets:manage)`);
  }

  const mods = await loadModules();
  const mod = mods.find((m) => m.id === moduleId);
  if (!mod) fail(`unknown module: ${moduleId}`);
  if (!mod.acl) {
    fail(
      `modules/${moduleId} has no src/api/acl.ts. Create it with defineAcl({ permissions: [], grants: {} }),\n` +
        `wire it into api/index.ts, run \`pnpm -r build\`, then retry.`,
    );
  }
  const existingOwner = mods.find((m) => (m.acl?.permissions ?? []).some((p) => p.id === permission));
  if (existingOwner) fail(`'${permission}' is already declared by module ${existingOwner.id}`);

  const grantRoles = (opts.grant ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const { roles } = await buildGrid(mods);
  for (const r of grantRoles) if (!roles.includes(r)) fail(`unknown role: ${r} (built-ins: ${roles.join(', ')})`);
  const implies = (opts.implies ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const i of implies) {
    if (!mods.some((m) => (m.acl?.permissions ?? []).some((p) => p.id === i))) fail(`--implies '${i}': no module declares it`);
  }

  const aclFile = join(mod.dir, 'src/api/acl.ts');
  let acl = readFileSync(aclFile, 'utf8');
  const entry =
    `    { id: '${permission}', title: '${opts.title.replace(/'/g, "\\'")}'` +
    `${implies.length ? `, implies: [${implies.map((i) => `'${i}'`).join(', ')}]` : ''} },\n`;
  const permsAnchor = /(permissions:\s*\[\n)([\s\S]*?)(\n?\s*\],)/;
  if (!permsAnchor.test(acl)) fail(`${moduleId}: could not find the \`permissions: [\` array in acl.ts`);
  acl = acl.replace(permsAnchor, (_m, open, body, close) => `${open}${body}\n${entry.replace(/\n$/, '')}${close}`);

  for (const role of grantRoles) {
    const listRe = new RegExp(`(${role}:\\s*\\[)([\\s\\S]*?)(\\],)`);
    const starRe = new RegExp(`${role}:\\s*'\\*'`);
    if (starRe.test(acl)) continue; // '*' already covers every permission this module declares
    if (listRe.test(acl)) {
      acl = acl.replace(listRe, (_m, open, body, close) => `${open}${body.replace(/,?\s*$/, ',')}\n      '${permission}',\n    ${close}`);
    } else {
      const grantsAnchor = /(grants:\s*\{\n)/;
      if (!grantsAnchor.test(acl)) fail(`${moduleId}: could not find the \`grants: {\` block in acl.ts`);
      acl = acl.replace(grantsAnchor, (m) => `${m}    ${role}: ['${permission}'],\n`);
    }
  }
  if (!opts.dry) writeFileSync(aclFile, acl);

  const ids = [...mod.acl.permissions.map((p) => p.id), permission];
  const changed = [aclFile, ...writeDerived(mod, ids, opts)];
  for (const f of changed) process.stdout.write(`${opts.dry ? 'would update' : 'updated'}  ${f.slice(root.length + 1)}\n`);
  process.stdout.write(
    `\n'${permission}' declared by ${moduleId}${grantRoles.length ? `, granted to ${grantRoles.join(', ')}` : ' (granted to no role yet)'}.\n` +
      `Next: gate a route with \`access: '${permission}'\`, then \`pnpm -r build && node scripts/acl.mjs check\`.\n`,
  );
}

// ---------------------------------------------------------------- entry

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const command = argv[0];
const positional = [];
const opts = {};
for (let i = 1; i < argv.length; i += 1) {
  const a = argv[i];
  if (!a.startsWith('--')) positional.push(a);
  else if (a === '--json' || a === '--strict' || a === '--dry') opts[a.slice(2)] = true;
  else {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) fail(`${a} requires a value`);
    opts[a.slice(2)] = value;
    i += 1;
  }
}
if (opts.by && !['role', 'module', 'permission'].includes(opts.by)) fail(`--by must be role, module or permission`);

const commands = {
  map: () => cmdMap(opts),
  check: () => cmdCheck(opts),
  add: () => cmdAdd(positional, opts),
  sync: () => cmdSync(opts),
};
if (!command || !commands[command]) {
  process.stderr.write(USAGE);
  process.exit(command ? 1 : 0);
}
await commands[command]();
