import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * `companion module verify <dir>` — static checks on an out-of-tree module,
 * before it is anywhere near a daemon.
 *
 * Everything here is mechanical and reads only files. That is the point: the
 * failures this catches are the ones a human review misses because they are
 * invisible until runtime and then silent. A module that bundled its own copy of
 * the SDK gets a second `Reply` class, so the router's `result instanceof Reply`
 * is false and every redirect comes back as a JSON-wrapped 200 with no error
 * anywhere. Parsing the import list costs nothing and rules out the whole class.
 */

/** What a built chunk is allowed to import. Anything else must be bundled in. */
const SERVER_ABI = new Set([
  '@moxxy/companion-sdk',
  '@moxxy/companion-sdk/server',
  '@moxxy/companion-sdk/agents',
  'better-sqlite3',
  'zod',
  'ws',
]);

const CLIENT_ABI = new Set([
  '@moxxy/companion-sdk',
  '@moxxy/companion-sdk/client',
  '@moxxy/companion-sdk/ui',
  'react',
  'react/jsx-runtime',
  'react-dom',
]);

const ABI_GENERATION = '0.x';

/** Resolved from the host, never from the module's own tree. */
const ABI_PACKAGES: readonly string[] = ['@moxxy/companion-sdk', '@moxxy/companion-contracts'];

interface Meta {
  id?: string;
  abi?: string;
  api?: string;
  client?: string;
  manifest?: string;
}

export function verifyModuleDir(dir: string): { ok: boolean; problems: string[]; notes: string[] } {
  const problems: string[] = [];
  const notes: string[] = [];
  const root = resolve(dir);

  const pkgFile = join(root, 'package.json');
  if (!existsSync(pkgFile)) return { ok: false, problems: [`${pkgFile} does not exist`], notes };

  let pkg: { name?: string; version?: string; moxxy?: Meta; dependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as typeof pkg;
  } catch (err) {
    return { ok: false, problems: [`package.json is not valid JSON: ${String(err)}`], notes };
  }

  const m = pkg.moxxy;
  if (!m) return { ok: false, problems: ['package.json has no "moxxy" block'], notes };
  for (const key of ['id', 'abi', 'api', 'manifest'] as const) {
    if (!m[key]) problems.push(`moxxy.${key} is missing`);
  }
  if (m.id && !/^[a-z][a-z0-9-]*$/.test(m.id)) problems.push(`moxxy.id '${m.id}' must be lower-case kebab-case`);
  if (m.abi && m.abi !== ABI_GENERATION) {
    problems.push(`moxxy.abi is '${m.abi}'; this Companion implements ${ABI_GENERATION}`);
  }

  // The mistake that produces a silent second class instance. Scoped to an
  // installed layout: npm never publishes node_modules, so its presence in an
  // author's working tree is normal and flagging it would train people to
  // ignore the check. What DOES ship it is a runtime dependency, below.
  const devTree = existsSync(join(root, 'src'));
  for (const abi of ABI_PACKAGES) {
    if (!devTree && existsSync(join(root, 'node_modules', ...abi.split('/')))) {
      problems.push(`node_modules/${abi} is present: it must be external at build time and must not be published`);
    }
  }
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    if (ABI_PACKAGES.includes(dep) || dep === 'react' || dep === 'react-dom') {
      problems.push(`'${dep}' is a runtime dependency; it must be a devDependency + peerDependency, never installed alongside`);
    }
  }

  for (const [key, allowed, label] of [
    ['api', SERVER_ABI, 'server'],
    ['client', CLIENT_ABI, 'client'],
  ] as const) {
    const rel = m[key];
    if (!rel) continue;
    const file = join(root, rel);
    if (!existsSync(file)) {
      problems.push(`moxxy.${key} points at ${rel}, which does not exist`);
      continue;
    }
    const imports = staticImports(readFileSync(file, 'utf8'));
    const bare = imports.filter((s) => !s.startsWith('.') && !s.startsWith('/') && !s.startsWith('node:'));
    const foreign = bare.filter((s) => !allowed.has(s));
    if (foreign.length) {
      problems.push(`${rel} imports outside the ${label} ABI: ${[...new Set(foreign)].join(', ')} (bundle them, or drop them)`);
    }
    notes.push(`${rel}: ${bare.length ? [...new Set(bare)].sort().join(', ') : 'no external imports'}`);
  }

  if (!m.client) notes.push('server-only module (no moxxy.client)');
  if (devTree) notes.push('working tree (src/ present): checks that only apply to a published package are skipped');
  if (devTree && !existsSync(join(root, 'dist'))) {
    problems.push('src/ present but no dist/: publish the built output, not sources');
  }
  return { ok: problems.length === 0, problems, notes };
}

/**
 * Static import specifiers only. A dynamic `import(expr)` is not resolvable
 * here, so it is reported as a problem rather than waved through: an ABI check
 * that can be evaded by string concatenation is not a check.
 */
function staticImports(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(?:^|[\s;}])(?:import|export)[\s\S]{0,400}?from\s*['"]([^'"]+)['"]/g)) out.push(m[1]!);
  for (const m of src.matchAll(/(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g)) out.push(m[1]!);
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]!);
  return out;
}

/** Walk an installed modules directory, for `verify` with no argument. */
export function installedModuleDirs(modulesRoot: string): string[] {
  if (!existsSync(modulesRoot)) return [];
  return readdirSync(modulesRoot)
    .filter((n) => n !== 'node_modules' && !n.startsWith('.'))
    .map((n) => join(modulesRoot, n))
    .filter((p) => statSync(p).isDirectory());
}
