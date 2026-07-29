import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModuleManifest } from '../manifest.js';
import type { ServerModule } from './context.js';
import type { InstalledModule } from './kernel.js';

/**
 * The `moxxy` block an out-of-tree module declares in its package.json. Read as
 * data, before anything is imported: install and compatibility decisions must
 * not require running the module's code.
 */
export interface ExternalModuleMeta {
  readonly id: string;
  /** SDK major this module was built against, e.g. `0.x` or `1.x`. */
  readonly abi: string;
  /** Server entry, relative to the package root. */
  readonly api: string;
  /** Prebuilt client chunk, served to the browser. Absent = server-only module. */
  readonly client?: string;
  /** Manifest entry (isomorphic, side-effect free). */
  readonly manifest: string;
}

export interface ExternalModule {
  readonly dir: string;
  readonly name: string;
  readonly version: string;
  readonly meta: ExternalModuleMeta;
}

/** Problems that make a directory unusable, phrased for an operator. */
export interface ExternalModuleProblem {
  readonly dir: string;
  readonly reason: string;
}

/**
 * The ABI generation this daemon implements. External modules declare which one
 * they were built against and are refused otherwise.
 *
 * Deliberately a generation, not a version range: while the SDK is pre-1.0 every
 * minor may break, and pretending otherwise with a caret range would let a module
 * built against 0.1 load into 0.4 and fail somewhere deep instead of at boot.
 */
export const ABI_GENERATION = '0.x';

/**
 * The packages a module must resolve from the host, never from its own tree.
 * Named individually rather than by scope: `@moxxy` also holds `@moxxy/cli`,
 * which has nothing to do with the ABI and is not a problem to vendor.
 */
export const ABI_PACKAGES: readonly string[] = ['@moxxy/companion-sdk', '@moxxy/companion-contracts'];

/** Read `$COMPANION_HOME/modules`, without importing anything. */
export function scanExternalModules(dir: string): {
  modules: ExternalModule[];
  problems: ExternalModuleProblem[];
} {
  const modules: ExternalModule[] = [];
  const problems: ExternalModuleProblem[] = [];
  if (!existsSync(dir)) return { modules, problems };

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // `node_modules` is the ABI bridge the daemon writes, not a module.
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const pkgFile = join(dir, entry.name, 'package.json');
    if (!existsSync(pkgFile)) {
      problems.push({ dir: entry.name, reason: 'no package.json' });
      continue;
    }
    let pkg: { name?: string; version?: string; moxxy?: Partial<ExternalModuleMeta> };
    try {
      pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as typeof pkg;
    } catch {
      problems.push({ dir: entry.name, reason: 'package.json is not valid JSON' });
      continue;
    }
    const problem = validate(entry.name, dir, pkg);
    if (problem) {
      problems.push({ dir: entry.name, reason: problem });
      continue;
    }
    const meta = pkg.moxxy as ExternalModuleMeta;
    modules.push({
      dir: join(dir, entry.name),
      name: pkg.name ?? entry.name,
      version: pkg.version ?? '0.0.0',
      meta,
    });
  }
  return { modules, problems };
}

function validate(
  dirName: string,
  root: string,
  pkg: { moxxy?: Partial<ExternalModuleMeta> },
): string | null {
  const m = pkg.moxxy;
  if (!m) return 'package.json has no "moxxy" block; this is not a Companion module';
  for (const key of ['id', 'abi', 'api', 'manifest'] as const) {
    if (typeof m[key] !== 'string' || !m[key]) return `moxxy.${key} is missing`;
  }
  if (!/^[a-z][a-z0-9-]*$/.test(m.id!)) return `moxxy.id '${m.id}' must be lower-case kebab-case`;
  if (m.id !== dirName) return `moxxy.id '${m.id}' must match the directory name '${dirName}'`;
  if (m.abi !== ABI_GENERATION) {
    return `built against SDK ABI ${m.abi}, but this Companion implements ${ABI_GENERATION}`;
  }
  // A vendored copy of an ABI package is the silent killer: the module resolves
  // its own `Reply` class, so `result instanceof Reply` in the router is false
  // and every redirect, HTML page and byte body comes back as a JSON-wrapped
  // 200. Measured, not theorised. Refuse at scan time, where it is one line.
  for (const abi of ABI_PACKAGES) {
    if (existsSync(join(root, dirName, 'node_modules', ...abi.split('/')))) {
      return `ships its own copy of ${abi}: mark it external when building and do not publish node_modules`;
    }
  }
  for (const key of ['api', 'manifest', 'client'] as const) {
    const rel = m[key];
    if (!rel) continue;
    // Refuse a path that escapes the package: an installed module directory is
    // the only thing the operator reviewed.
    const abs = resolve(root, dirName, rel);
    if (!abs.startsWith(resolve(root, dirName) + '/')) return `moxxy.${key} points outside the module directory`;
    if (!existsSync(abs)) return `moxxy.${key} points at ${rel}, which does not exist`;
  }
  return null;
}

/**
 * Turn scanned directories into kernel entries.
 *
 * The manifest is imported eagerly (it is a side-effect-free metafile, the same
 * shape the generated in-tree registry imports at module scope), while the `/api`
 * bundle stays behind the lazy `load()` thunk so a disabled external module costs
 * nothing at boot.
 */
export async function loadExternalModules(
  modules: readonly ExternalModule[],
  onError: (id: string, err: unknown) => void,
): Promise<InstalledModule[]> {
  const out: InstalledModule[] = [];
  for (const mod of modules) {
    try {
      const url = pathToFileURL(join(mod.dir, mod.meta.manifest)).href;
      const manifest = ((await import(url)) as { default: ModuleManifest }).default;
      if (manifest?.id !== mod.meta.id) {
        throw new Error(`manifest declares id '${manifest?.id}', package.json says '${mod.meta.id}'`);
      }
      out.push({
        manifest,
        dir: mod.dir,
        externalClient: typeof mod.meta.client === 'string' && mod.meta.client.length > 0,
        load: async (): Promise<ServerModule> => {
          const api = pathToFileURL(join(mod.dir, mod.meta.api)).href;
          return ((await import(api)) as { default: ServerModule }).default;
        },
      });
    } catch (err) {
      onError(mod.meta.id, err);
    }
  }
  return out;
}
