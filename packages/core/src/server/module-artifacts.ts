import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { installedModuleDirs, verifyModuleDir } from './module-verify.js';

const run = promisify(execFile);

/**
 * The files of an out-of-tree module in `$COMPANION_HOME/modules`: obtaining
 * them, recording where they came from, and deleting them again. One
 * implementation behind two callers, `companion module add|remove` and the
 * daemon's own admin routes, because a second copy of code that fetches and
 * executes foreign bytes is how the two drift.
 *
 * Nothing here touches a daemon: `add` only fetches and checks files, which is
 * why it works while Companion is down. Adopting a module (migrations,
 * services, routes) stays `install`, a different act on a different machine's
 * clock that needs the directory to have been scanned at boot first.
 *
 * Nothing here resolves dependencies either, and that is deliberate rather than
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

export interface RemoveResult {
  readonly id: string;
  readonly dir: string;
  /** false = nothing was on disk under this id, so this call deleted nothing. */
  readonly removed: boolean;
  /** The ledger entry that was dropped, for the caller's audit line. */
  readonly provenance: ModuleProvenance | null;
}

/**
 * The one failure a caller can offer a next step for, so it is a type rather
 * than a message to match on: the CLI turns it into `--force`, the route into a
 * 409 the admin surface answers with a Replace button.
 */
export class ModuleAlreadyAddedError extends Error {
  constructor(
    readonly id: string,
    /** Version currently in the modules directory. */
    readonly installed: string,
    message: string,
  ) {
    super(message);
  }
}

const PROVENANCE = '.provenance.json';

/**
 * A module id is a directory name under the modules root, so it decides where
 * these functions write and what they delete. Kebab-case only, which is also
 * what `scanExternalModules` requires of `moxxy.id`.
 */
const MODULE_ID = /^[a-z][a-z0-9-]*$/;

export const isModuleId = (id: string): boolean => MODULE_ID.test(id);

/**
 * A spec naming a package in a registry: `name`, `@scope/name`, either with an
 * optional `@version`, `@range` or `@tag`.
 *
 * `npm pack` accepts far more than this (filesystem paths, tarball URLs, git
 * remotes), and the extra reach is the point of the CLI: the operator running
 * it already has a shell on the host. It is not the point of a route, where the
 * caller is a browser. A path spec would turn "add a module" into "copy any
 * directory the daemon can read into the directory the daemon imports from",
 * and a git spec is worse still, because npm builds those, which runs the
 * repository's `prepare` script as the daemon user BEFORE anything is verified.
 * A registry tarball is only ever extracted.
 */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
/** No `:`, so an alias (`pkg@npm:other`) or a path (`pkg@file:.`) cannot ride in. */
const VERSION_OR_TAG = /^[a-zA-Z0-9.\-_+^~><=*| ]+$/;

export function isRegistrySpec(spec: string): boolean {
  const at = spec.lastIndexOf('@');
  const name = at > 0 ? spec.slice(0, at) : spec;
  const range = at > 0 ? spec.slice(at + 1) : null;
  if (!PACKAGE_NAME.test(name)) return false;
  return range === null || VERSION_OR_TAG.test(range);
}

/**
 * Asynchronous because one of its two callers is a daemon: `npm pack` goes to
 * the network, and a synchronous fetch would stop the event loop for as long as
 * the registry takes, freezing every other request and every agent run with it.
 */
export async function addModule(spec: string, modulesRoot: string, force: boolean): Promise<AddResult> {
  const work = mkdtempSync(join(tmpdir(), 'companion-add-'));
  try {
    const packed = await pack(spec, work);
    await run('tar', ['-xzf', join(work, packed.filename), '-C', work]);
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
      throw new ModuleAlreadyAddedError(
        id,
        replaced,
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
      registry: await configuredRegistry(),
      addedAt: new Date().toISOString(),
    };
    recordProvenance(modulesRoot, id, provenance);
    return { id, dir, replaced, provenance, notes: check.notes };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Delete a module's files and its ledger entry.
 *
 * The other half of `remove` (rolling back migrations and wiping configuration)
 * belongs to the kernel and happens before this, so that a module is only ever
 * deleted once its ledger is clean. Deleting files a module still has tables
 * for would leave a schema nobody can migrate down.
 */
export function removeModule(id: string, modulesRoot: string): RemoveResult {
  // The one thing between an id from a URL and `rm -rf` somewhere else.
  if (!isModuleId(id)) throw new Error(`'${id}' is not a module id.`);
  const dir = join(modulesRoot, id);
  const removed = existsSync(dir);
  if (removed) rmSync(dir, { recursive: true, force: true });
  const ledger = readProvenance(modulesRoot);
  const provenance = ledger[id] ?? null;
  if (provenance) {
    delete ledger[id];
    writeProvenance(modulesRoot, ledger);
  }
  return { id, dir, removed, provenance };
}

/** One module's files on disk, with the ledger entry that says where they came from. */
export interface ModuleArtifact {
  /** Directory name, which the scan requires to equal the module's declared id. */
  readonly id: string;
  readonly dir: string;
  readonly name: string | null;
  readonly version: string | null;
  /** null when the directory was copied in by hand rather than added. */
  readonly provenance: ModuleProvenance | null;
}

/**
 * What is in the modules directory right now, which is a different question
 * from what the daemon loaded: the scan runs once at boot, so files added since
 * are here and not running.
 *
 * One ledger read plus one package.json read per directory. Directories are
 * counted in single digits and only the admin surface asks, so this stays a
 * plain read rather than anything cached.
 */
export function listModuleArtifacts(modulesRoot: string): ModuleArtifact[] {
  const ledger = readProvenance(modulesRoot);
  return installedModuleDirs(modulesRoot).map((dir) => {
    const id = basename(dir);
    const pkg = readPackage(dir);
    return {
      id,
      dir,
      name: pkg?.name ?? null,
      version: pkg?.version ?? null,
      provenance: ledger[id] ?? null,
    };
  });
}

function readPackage(dir: string): { name?: string; version?: string } | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
  } catch {
    // A directory that is not a package still belongs in the list: it is
    // exactly what an operator needs to see in order to delete it.
    return null;
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
  writeProvenance(modulesRoot, { ...readProvenance(modulesRoot), [id]: entry });
}

function writeProvenance(modulesRoot: string, all: Record<string, ModuleProvenance>): void {
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
async function pack(spec: string, into: string): Promise<Packed> {
  let raw: string;
  try {
    ({ stdout: raw } = await run('npm', ['pack', spec, '--json', '--pack-destination', into], {
      encoding: 'utf8',
    }));
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
async function configuredRegistry(): Promise<string | null> {
  try {
    const { stdout } = await run('npm', ['config', 'get', 'registry'], { encoding: 'utf8' });
    return stdout.trim() || null;
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

const installedVersion = (dir: string): string => readPackage(dir)?.version ?? 'unknown';
