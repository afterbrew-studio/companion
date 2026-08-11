#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const onlyUnpublished = process.argv.includes('--unpublished');
const checkBuiltImports = process.argv.includes('--check-built-imports');
const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const include = [];

for (const base of ['apps', 'packages', 'modules']) {
  const entries = readdirSync(join(root, base), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const dir = `${base}/${entry.name}`;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (manifest.private === true) continue;
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
      throw new Error(`${dir}/package.json is public but has no name or version`);
    }
    if (!packageNamePattern.test(manifest.name) || !semverPattern.test(manifest.version)) {
      throw new Error(`${dir}/package.json has an unsafe package name or non-semantic version`);
    }
    if (manifest.name.startsWith('@') && manifest.publishConfig?.access !== 'public') {
      throw new Error(`${manifest.name} is scoped and must declare publishConfig.access=public`);
    }
    include.push({
      dir,
      package: manifest.name,
      version: manifest.version,
      dependencies: Object.keys({
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies,
      }),
    });
  }
}

if (!include.some((entry) => entry.package === '@moxxy/companion')) {
  throw new Error('the product package @moxxy/companion is not publishable');
}

if (checkBuiltImports) {
  checkPackageImports(include);
  console.log(`release dependency check: ${include.length} built public package(s) declare every bare import`);
  process.exit(0);
}

/** Publish workspace dependencies before anything that names their new version. */
function dependencyOrder(entries) {
  const byName = new Map(entries.map((entry) => [entry.package, entry]));
  const visiting = new Set();
  const visited = new Set();
  const ordered = [];

  const visit = (entry) => {
    if (visited.has(entry.package)) return;
    if (visiting.has(entry.package)) throw new Error(`public package dependency cycle at ${entry.package}`);
    visiting.add(entry.package);
    for (const dependency of entry.dependencies.filter((name) => byName.has(name)).sort()) {
      visit(byName.get(dependency));
    }
    visiting.delete(entry.package);
    visited.add(entry.package);
    ordered.push(entry);
  };

  for (const entry of entries) visit(entry);
  return ordered;
}

function isPublished(entry) {
  try {
    const found = execFileSync('npm', ['view', `${entry.package}@${entry.version}`, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (found !== entry.version) {
      throw new Error(`registry returned '${found}'`);
    }
    return true;
  } catch (error) {
    const output = `${error?.stdout ?? ''}${error?.stderr ?? ''}`;
    if (/E404|404 Not Found|is not in this registry/i.test(output)) return false;
    const reason = output.trim().split('\n').at(-1) || error?.message || 'unknown registry error';
    throw new Error(`could not verify ${entry.package}@${entry.version}: ${reason}`);
  }
}

const ordered = dependencyOrder(include);
const selected = onlyUnpublished ? ordered.filter((entry) => !isPublished(entry)) : ordered;
console.log(JSON.stringify({
  include: selected.map(({ dir, package: name, version }) => ({ dir, package: name, version })),
}));

/** A devDependency is not installed for consumers, so it cannot satisfy emitted code or types. */
function checkPackageImports(entries) {
  for (const entry of entries) {
    const dist = join(root, entry.dir, 'dist');
    if (!existsSync(dist)) throw new Error(`${entry.dir}/dist is missing; build before checking package imports`);
    const declared = new Set(entry.dependencies);
    for (const file of filesUnder(dist)) {
      if (!/\.(?:js|d\.ts)$/.test(file)) continue;
      const source = readFileSync(file, 'utf8');
      const executable = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const imports = /(?:^\s*(?:(?:import|export)\b[^\n;]*?\bfrom|}\s*from)\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/gm;
      for (const match of executable.matchAll(imports)) {
        const specifier = match[1];
        if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) continue;
        const dependency = packageName(specifier);
        if (builtinModules.includes(specifier) || builtinModules.includes(dependency)) continue;
        // Bundles may contain example/template source such as
        // `from '${cmd.from}'`; it is data, not a resolvable module specifier.
        if (!packageNamePattern.test(dependency)) continue;
        if (dependency === entry.package || declared.has(dependency)) continue;
        throw new Error(`${entry.package} emits an import of ${dependency} in ${file.slice(root.length + 1)}, but does not declare it as a dependency or peer`);
      }
    }
  }
}

function filesUnder(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function packageName(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}
