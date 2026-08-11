#!/usr/bin/env node
/**
 * Decide the next version of every publishable package, from what actually
 * changed and from what the commits say about it.
 *
 *   node scripts/version.mjs           # write the new versions
 *   node scripts/version.mjs --check   # report only, exit 1 if a release is due
 *
 * Why not changesets or release-please as they come: both answer "what changed"
 * from file paths, and in this repo that answer is wrong. `@moxxy/companion`
 * BUNDLES the workspace, so a fix in `modules/code` ships inside it while living
 * nowhere near `apps/companion-cli`. So the unit here is the package's workspace
 * dependency closure, not its directory.
 *
 * The level comes from conventional-commit types, which the history already
 * follows. A commit that only touches docs, tests or CI cannot change a tarball,
 * so it never forces a release on its own.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

/**
 * The version as committed, not as it sits in the working tree.
 *
 * Running twice before committing would otherwise bump twice: the second run
 * cannot find the freshly written version anywhere in history, so it reads the
 * whole log as unreleased. Anchoring on HEAD makes a repeat run rewrite the same
 * number.
 */
function releasedVersion(dir, fallback) {
  try {
    return JSON.parse(git('show', `HEAD:${dir}/package.json`)).version ?? fallback;
  } catch {
    return fallback;
  }
}

/** Every workspace package, by name, with the directory it lives in. */
function workspace() {
  const out = new Map();
  for (const base of ['apps', 'examples', 'packages', 'modules']) {
    for (const entry of readdirSync(join(root, base))) {
      const dir = `${base}/${entry}`;
      const manifest = join(root, dir, 'package.json');
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      if (pkg.name) out.set(pkg.name, { dir, pkg, manifest, released: releasedVersion(dir, pkg.version) });
    }
  }
  return out;
}

/**
 * Directories whose contents end up inside this package's artifact. Follows
 * devDependencies as well: the CLI reaches `companion-api` and `companion-web`
 * through those, and they are exactly what it bundles.
 */
function closure(name, packages) {
  const seen = new Set([name]);
  const queue = [name];
  while (queue.length) {
    const current = packages.get(queue.pop());
    if (!current) continue;
    const deps = { ...current.pkg.dependencies, ...current.pkg.devDependencies };
    for (const [dep, spec] of Object.entries(deps)) {
      if (!String(spec).startsWith('workspace:') || seen.has(dep)) continue;
      seen.add(dep);
      queue.push(dep);
    }
  }
  return [...seen].map((n) => packages.get(n)?.dir).filter(Boolean);
}

/** The commit that set the version this package currently declares. */
function releasePoint(dir, version) {
  const found = git(
    'log', '-1', '--format=%H', `-S"version": "${version}"`, '--', `${dir}/package.json`,
  );
  // No match means the version predates the available history (a shallow clone,
  // or a package that has never been bumped): treat everything as unreleased.
  return found || null;
}

/** Anything that cannot end up in a tarball must not force a release. */
const IRRELEVANT = /(^|\/)(tests?|__tests__)\//;
/**
 * A README is the exception among markdown files: npm packs it whatever `files`
 * says, and it IS the package page. Treating it like the rest of the docs would
 * leave a corrected README unpublishable, because nothing would ever mark the
 * package as having unreleased changes.
 *
 * Only its OWN README, though. The closure is directory-shaped, so a dependency's
 * README shows up in the diff of everything that bundles it, and a line about
 * `@moxxy/companion-sdk` never reaches the CLI's tarball.
 */
const relevantTo = (ownDir) => (file) =>
  !IRRELEVANT.test(file) &&
  !file.startsWith('docs/') &&
  !file.startsWith('.github/') &&
  (!file.endsWith('.md') || file === `${ownDir}/README.md`);

function changesSince(point, dirs, ownDir) {
  const isRelevant = relevantTo(ownDir);
  const range = point ? `${point}..HEAD` : 'HEAD';
  const raw = git('log', range, '--format=%x01%H%x00%s%x00%b', '--name-only', '--', ...dirs);
  if (!raw) return [];
  return raw
    .split('\x01')
    .filter(Boolean)
    .map((block) => {
      const [meta, ...rest] = block.split('\n');
      const [hash, subject, body] = meta.split('\x00');
      const files = rest.filter((l) => l.trim() && !l.startsWith('\x00'));
      return { hash, subject: subject ?? '', body: body ?? '', files };
    })
    .filter((c) => c.files.some(isRelevant));
}

/** major on a `!` or a BREAKING CHANGE trailer, minor on a feat, else patch. */
function level(commits) {
  let result = 'patch';
  for (const c of commits) {
    if (/^[a-z]+(\([^)]*\))?!:/.test(c.subject) || /BREAKING[ -]CHANGE/.test(c.body)) return 'major';
    if (/^feat(\([^)]*\))?:/.test(c.subject)) result = 'minor';
  }
  return result;
}

function bump(version, how) {
  const [major, minor, patch] = version.split('.').map((n) => Number.parseInt(n, 10));
  if ([major, minor, patch].some(Number.isNaN)) throw new Error(`cannot bump a non-semver version: ${version}`);
  // Pre-1.0: a breaking change is a minor, which is what the ecosystem means by
  // 0.x. Promoting to 1.0.0 is a decision, not something a commit message makes.
  if (major === 0) return how === 'major' ? `0.${minor + 1}.0` : how === 'minor' ? `0.${minor + 1}.0` : `0.${minor}.${patch + 1}`;
  if (how === 'major') return `${major + 1}.0.0`;
  if (how === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * Is this exact version already on the registry?
 *
 * A package whose current version has never been published has nothing to bump:
 * what is in the tree IS the unreleased version. Bumping it would burn 0.1.0 for
 * no one. This asks the same question the publish workflow asks, so the two
 * cannot disagree. An unreachable registry proposes a bump, which risks a
 * needless version rather than a change that never ships.
 */
function isPublished(name, version) {
  try {
    execFileSync('npm', ['view', `${name}@${version}`, 'version'], { stdio: 'pipe', encoding: 'utf8' });
    return true;
  } catch (err) {
    const output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    return !/E404|404 Not Found|is not in this registry/i.test(output);
  }
}

const packages = workspace();
const publishable = [...packages.values()].filter((p) => p.pkg.private !== true && p.pkg.name);

const planned = [];
const unreleased = [];
for (const target of publishable) {
  if (!isPublished(target.pkg.name, target.released)) {
    unreleased.push(`${target.pkg.name}@${target.released}`);
    continue;
  }
  const dirs = closure(target.pkg.name, packages);
  const point = releasePoint(target.dir, target.released);
  const commits = changesSince(point, dirs, target.dir);
  if (!commits.length) continue;
  const how = level(commits);
  planned.push({ ...target, how, next: bump(target.released, how), commits, dirs });
}

if (unreleased.length) {
  console.log(`Already unreleased, publishing as is: ${unreleased.join(', ')}`);
}
if (!planned.length) {
  console.log('No publishable package has unreleased changes.');
  process.exit(0);
}

for (const p of planned) {
  console.log(`${p.pkg.name}  ${p.released} -> ${p.next}  (${p.how}, ${p.commits.length} commit(s), ${p.dirs.length} package(s) in closure)`);
  for (const c of p.commits.slice(0, 8)) console.log(`    ${c.hash.slice(0, 7)} ${c.subject}`);
  if (p.commits.length > 8) console.log(`    ... and ${p.commits.length - 8} more`);
}

if (check) {
  console.log('\nRun `node scripts/version.mjs` to apply.');
  process.exit(1);
}

for (const p of planned) {
  const raw = readFileSync(p.manifest, 'utf8');
  if (!/("version":\s*)"[^"]+"/.test(raw)) throw new Error(`no version field in ${p.manifest}`);
  // Rewrite the one line, so formatting and key order survive untouched. An
  // identical result means a repeat run on an already-bumped tree, which is a
  // no-op rather than a failure.
  writeFileSync(p.manifest, raw.replace(/("version":\s*)"[^"]+"/, `$1"${p.next}"`));
}

/**
 * Carry the release into ranges that name a bumped package explicitly.
 *
 * `workspace:*` needs none of this, because pnpm resolves it at pack time. A
 * caret does: the SDK peers on `@moxxy/companion-contracts`, and `^0.1.0` does
 * not admit 0.2.0, so a release that moved one without the other would install
 * as an unmet peer for everyone.
 */
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const realigned = [];
for (const { manifest } of packages.values()) {
  const raw = readFileSync(manifest, 'utf8');
  let next = raw;
  for (const p of planned) {
    next = next.replace(new RegExp(`("${escape(p.pkg.name)}":\\s*")\\^[^"]*(")`, 'g'), `$1^${p.next}$2`);
  }
  if (next === raw) continue;
  writeFileSync(manifest, next);
  realigned.push(manifest);
}

/**
 * The SDK reports its own version from a source literal, because a bundled
 * package cannot read its package.json at runtime. `pnpm sdk:surface` fails when
 * the two disagree, so without this every SDK release would open a pull request
 * that cannot go green.
 */
const sdk = planned.find((p) => p.pkg.name === '@moxxy/companion-sdk');
if (sdk) {
  const file = join(root, 'packages/sdk/src/index.ts');
  const raw = readFileSync(file, 'utf8');
  const pattern = /(export const SDK_VERSION = ')[^']+(')/;
  if (!pattern.test(raw)) throw new Error(`${file} no longer declares SDK_VERSION`);
  writeFileSync(file, raw.replace(pattern, `$1${sdk.next}$2`));
}

console.log(`\nWrote ${planned.length} version(s).`);
if (realigned.length) console.log(`Realigned dependency ranges in ${realigned.length} manifest(s).`);
if (sdk) console.log(`Set SDK_VERSION to ${sdk.next}.`);
