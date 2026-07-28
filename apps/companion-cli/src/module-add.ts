import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyModuleDir } from './verify.js';

/**
 * `companion module add <spec>` obtains an out-of-tree module from a registry
 * and places it where the daemon looks, which until now meant copying a
 * directory in by hand.
 *
 * No daemon is involved and none is required, the same as `verify`: this only
 * fetches files and checks them. Adopting the module (migrations, services,
 * routes) stays `module install <id>`, because that is a different act on a
 * different machine's clock, and it needs the daemon to have scanned the
 * directory first.
 *
 * Nothing here resolves dependencies, and that is deliberate rather than
 * unfinished. `verify` already requires a module's entry chunks to import the
 * ABI and nothing else, so a publishable module has bundled its libraries.
 * Running an install would only be able to produce the one thing the ABI cannot
 * survive: a second copy of the SDK inside the module, which makes every
 * `instanceof` against a host class false.
 */

/** Where a module came from, recorded because nobody can reconstruct it later. */
export interface ModuleProvenance {
  /** As typed, so `latest` stays distinguishable from the version it resolved to. */
  readonly spec: string;
  readonly name: string;
  readonly version: string;
  readonly integrity: string | null;
  /** The registry npm was pointed at, which for a path or git spec means nothing. */
  readonly registry: string | null;
  readonly addedAt: string;
}

export interface AddResult {
  readonly id: string;
  readonly dir: string;
  readonly replaced: string | null;
  readonly provenance: ModuleProvenance;
  readonly notes: readonly string[];
}

const PROVENANCE = '.provenance.json';

export function addModule(spec: string, modulesRoot: string, force: boolean): AddResult {
  const work = mkdtempSync(join(tmpdir(), 'companion-add-'));
  try {
    const packed = pack(spec, work);
    execFileSync('tar', ['-xzf', join(work, packed.filename), '-C', work], { stdio: 'pipe' });
    // Every npm tarball roots its content at `package/`.
    const staged = join(work, 'package');
    if (!existsSync(join(staged, 'package.json'))) {
      throw new Error(`${spec} does not unpack to a package directory.`);
    }

    const id = moduleId(staged, spec);
    // Checked while it is still in the staging directory: a module that fails
    // must not have been anywhere the daemon scans, however briefly.
    const check = verifyModuleDir(staged);
    if (!check.ok) {
      throw new Error(
        `${packed.name}@${packed.version} is not a loadable Companion module:\n` +
          check.problems.map((p) => `  ! ${p}`).join('\n'),
      );
    }

    const dir = join(modulesRoot, id);
    const replaced = existsSync(dir) ? installedVersion(dir) : null;
    if (replaced !== null && !force) {
      throw new Error(
        `${id} is already installed at ${dir} (version ${replaced}).\n` +
          `Pass --force to replace its files with ${packed.version}.`,
      );
    }

    mkdirSync(modulesRoot, { recursive: true });
    // Replace rather than merge: a file the new version dropped would otherwise
    // survive and keep being imported.
    if (replaced !== null) rmSync(dir, { recursive: true, force: true });
    cpSync(staged, dir, { recursive: true });

    const provenance: ModuleProvenance = {
      spec,
      name: packed.name,
      version: packed.version,
      integrity: packed.integrity ?? null,
      registry: configuredRegistry(),
      addedAt: new Date().toISOString(),
    };
    recordProvenance(modulesRoot, id, provenance);
    return { id, dir, replaced, provenance, notes: check.notes };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Provenance for every module added this way, by id. */
export function readProvenance(modulesRoot: string): Record<string, ModuleProvenance> {
  const file = join(modulesRoot, PROVENANCE);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, ModuleProvenance>;
  } catch {
    // A corrupt ledger must not stop an install; it is a record, not a gate.
    return {};
  }
}

function recordProvenance(modulesRoot: string, id: string, entry: ModuleProvenance): void {
  const all = { ...readProvenance(modulesRoot), [id]: entry };
  writeFileSync(join(modulesRoot, PROVENANCE), `${JSON.stringify(all, null, 2)}\n`);
}

interface Packed {
  readonly name: string;
  readonly version: string;
  readonly filename: string;
  readonly integrity?: string;
}

/**
 * npm resolves the spec, so a scope, a tag, a version range, a git URL and a
 * local tarball all work, and so do a private registry and its credentials,
 * without this file knowing anything about any of it.
 */
function pack(spec: string, into: string): Packed {
  let raw: string;
  try {
    raw = execFileSync('npm', ['pack', spec, '--json', '--pack-destination', into], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const detail = `${(err as { stderr?: string }).stderr ?? ''}`.trim();
    throw new Error(`Could not fetch ${spec}.${detail ? `\n${detail}` : ''}`);
  }
  const parsed = JSON.parse(raw) as Packed[];
  const first = parsed[0];
  if (!first) throw new Error(`npm pack ${spec} produced nothing.`);
  return first;
}

/**
 * Read, not fetched: `npm pack` has already been to the network, and asking it
 * again for a tarball URL would cost a round trip to record something the
 * registry, name and version already say.
 */
function configuredRegistry(): string | null {
  try {
    const raw = execFileSync('npm', ['config', 'get', 'registry'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return raw.trim() || null;
  } catch {
    return null;
  }
}

function moduleId(dir: string, spec: string): string {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { moxxy?: { id?: string } };
  const id = pkg.moxxy?.id;
  if (!id) throw new Error(`${spec} has no "moxxy" block in its package.json, so it is not a Companion module.`);
  return id;
}

function installedVersion(dir: string): string {
  try {
    return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
