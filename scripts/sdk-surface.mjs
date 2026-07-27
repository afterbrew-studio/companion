#!/usr/bin/env node
/**
 * Guard the published module ABI.
 *
 *   node scripts/sdk-surface.mjs          # compare against the snapshot
 *   node scripts/sdk-surface.mjs --write  # accept the current surface
 *
 * `@moxxy-ai/companion-sdk` is a permanent public surface: an external module
 * compiled against it must keep compiling. The risk is not a deliberate change,
 * it is an accidental one. Every entry point but `/ui` is an explicit named
 * re-export list, so adding a symbol to a barrel in `@companion/core` cannot
 * widen the ABI by itself; `/ui` IS a wildcard, so a component deleted there
 * silently breaks every module that rendered it. This catches both directions.
 *
 * Removals and renames are the failures that matter. Additions are reported too,
 * because "what went into the ABI in this release" is a question with an answer.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const snapshotFile = join(root, 'packages/sdk/surface.json');
const write = process.argv.includes('--write');

/** Named re-exports (`export { a, b } from '...'`), values and types alike. */
function namedExports(src) {
  const out = new Set();
  for (const m of src.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*from/g)) {
    for (let s of m[1].split(',')) {
      s = s.trim().replace(/^type\s+/, '');
      const as = s.split(/\s+as\s+/);
      const name = (as[1] ?? as[0] ?? '').trim();
      if (name) out.add(name);
    }
  }
  return out;
}

/** Locally declared exports, for a barrel that defines as well as re-exports. */
function ownExports(src) {
  const out = new Set();
  for (const m of src.matchAll(
    /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:class|function|const|let|interface|type|enum)\s+([A-Za-z0-9_$]+)/gm,
  )) {
    out.add(m[1]);
  }
  return out;
}

/** `@companion/ui` is re-exported wholesale, so expand it: a deletion there is an ABI break. */
function expandUi() {
  const dir = join(root, 'packages/ui/src');
  const barrel = readFileSync(join(dir, 'index.ts'), 'utf8');
  const out = new Set();
  for (const m of barrel.matchAll(/export\s+\*\s+from\s+'\.\/([^']+)\.js'/g)) {
    const base = join(dir, m[1]);
    const file = ['.ts', '.tsx'].map((e) => base + e).find(existsSync);
    if (!file) continue;
    const src = readFileSync(file, 'utf8');
    for (const n of ownExports(src)) out.add(n);
    for (const n of namedExports(src)) out.add(n);
  }
  return out;
}

const entries = {
  '.': 'src/index.ts',
  './server': 'src/server.ts',
  './agents': 'src/agents.ts',
  './client': 'src/client.tsx',
};

const current = {};
for (const [entry, rel] of Object.entries(entries)) {
  const src = readFileSync(join(root, 'packages/sdk', rel), 'utf8');
  current[entry] = [...new Set([...namedExports(src), ...ownExports(src)])].sort();
}
current['./ui'] = [...expandUi()].sort();

if (write) {
  writeFileSync(snapshotFile, JSON.stringify(current, null, 2) + '\n');
  const total = Object.values(current).reduce((n, l) => n + l.length, 0);
  console.log(`wrote packages/sdk/surface.json: ${total} symbols across ${Object.keys(current).length} entry points`);
  process.exit(0);
}

if (!existsSync(snapshotFile)) {
  console.error('no packages/sdk/surface.json. Run: node scripts/sdk-surface.mjs --write');
  process.exit(1);
}

const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8'));
const problems = [...clientAbiDrift()];
const added = [];
for (const entry of new Set([...Object.keys(snapshot), ...Object.keys(current)])) {
  const before = new Set(snapshot[entry] ?? []);
  const after = new Set(current[entry] ?? []);
  if (!snapshot[entry]) problems.push(`new entry point '${entry}' is not in the snapshot`);
  if (!current[entry]) problems.push(`entry point '${entry}' was removed; every module importing it breaks`);
  for (const n of before) if (!after.has(n)) problems.push(`${entry}: '${n}' was removed from the ABI`);
  for (const n of after) if (!before.has(n)) added.push(`${entry}: '${n}'`);
}

if (added.length) {
  console.log(`${added.length} addition(s) to the ABI:`);
  for (const a of added) console.log(`  + ${a}`);
}
if (problems.length) {
  console.error(`\n${problems.length} breaking change(s):`);
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nIf intended, bump the SDK major and run: node scripts/sdk-surface.mjs --write');
  process.exit(1);
}
const total = Object.values(current).reduce((n, l) => n + l.length, 0);
console.log(`SDK surface: ${total} symbols across ${Object.keys(current).length} entry points, no breaking change`);

/**
 * The browser ABI is written down twice, and it has to stay one list: the import
 * map in `apps/web/vite.config.ts` decides what a module chunk CAN resolve, and
 * the allowlist in the CLI decides what `module verify` LETS it import. Drift in
 * either direction is a bad day: a specifier the verifier permits but the map
 * omits fails at load, and one the map serves but the verifier rejects makes a
 * legitimate module unpublishable.
 */
function clientAbiDrift() {
  const block = (file, re) => {
    const m = re.exec(readFileSync(join(root, file), 'utf8'));
    return m ? m[1] : null;
  };
  const mapBody = block('apps/web/vite.config.ts', /const HOST_MODULES = \{([\s\S]*?)\} as const;/);
  const allowBody = block('apps/companion-cli/src/verify.ts', /const CLIENT_ABI = new Set\(\[([\s\S]*?)\]\);/);
  if (!mapBody || !allowBody) return ['could not read the client ABI from vite.config.ts or verify.ts'];

  // HOST_MODULES is `specifier: filename`, so read KEYS: taking every quoted
  // string would also pick up the file names and quietly compare the wrong set.
  const map = new Set([...mapBody.matchAll(/^\s*'?([^'\s:,]+)'?\s*:/gm)].map((m) => m[1]));
  const allow = new Set([...allowBody.matchAll(/'([^']+)'/g)].map((m) => m[1]));

  const out = [];
  for (const s of map) if (!allow.has(s)) out.push(`import map serves '${s}' but module verify rejects it`);
  for (const s of allow) if (!map.has(s)) out.push(`module verify allows '${s}' but the import map cannot resolve it`);
  return out;
}
