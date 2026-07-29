import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addModule,
  isRegistrySpec,
  ModuleAlreadyAddedError,
  listModuleArtifacts,
  readProvenance,
  removeModule,
} from '../dist/server/index.js';

/**
 * A real publishable module on disk, packed by npm exactly as a registry one
 * would be. `addModule` shells out to npm and tar, so stubbing either would
 * leave the part most likely to be wrong untested.
 */
function publishable(root, { id = 'reports', version = '1.0.0', api, extra = {} } = {}) {
  const dir = join(root, `src-${id}-${version}`);
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'api.js'), api ?? "import { log } from '@moxxy/companion-sdk/server';\nexport default {};\n");
  writeFileSync(join(dir, 'dist', 'module.js'), 'export default {};\n');
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: `companion-module-${id}`,
      version,
      moxxy: { id, abi: '0.x', api: './dist/api.js', manifest: './dist/module.js' },
      ...extra,
    }),
  );
  return dir;
}

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'companion-add-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, modules: join(dir, 'modules') };
}

test('add fetches, unpacks and records where the module came from', async (t) => {
  const box = sandbox(t);
  const source = publishable(box.dir);

  const result = await addModule(source, box.modules, false);

  assert.equal(result.id, 'reports');
  assert.equal(result.replaced, null);
  assert.equal(
    JSON.parse(readFileSync(join(box.modules, 'reports', 'package.json'), 'utf8')).version,
    '1.0.0',
  );
  const record = readProvenance(box.modules).reports;
  assert.equal(record.name, 'companion-module-reports');
  assert.equal(record.version, '1.0.0');
  assert.equal(record.spec, source);
  // The whole point of recording it: an operator asked to trust this module can
  // check the bytes against what the registry served.
  assert.match(record.integrity, /^sha\d+-/);
});

test('a module that fails the ABI check never reaches the modules directory', async (t) => {
  const box = sandbox(t);
  // Importing outside the ABI is the failure `verify` exists to catch.
  const source = publishable(box.dir, { id: 'bad', api: "import x from 'left-pad';\nexport default {};\n" });

  await assert.rejects(
    () => addModule(source, box.modules, false),
    /not a loadable Companion module[\s\S]*left-pad/,
  );
  assert.equal(existsSync(join(box.modules, 'bad')), false, 'a refused module must never have been placed');
  assert.deepEqual(readProvenance(box.modules), {}, 'a refused module must leave no trace');
});

test('a package with no moxxy block is refused as not a module', async (t) => {
  const box = sandbox(t);
  const dir = join(box.dir, 'plain');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'plain', version: '1.0.0' }));

  await assert.rejects(() => addModule(dir, box.modules, false), /is not a Companion module/);
});

test('replacing an installed module needs --force, and then says what it replaced', async (t) => {
  const box = sandbox(t);
  await addModule(publishable(box.dir, { version: '1.0.0' }), box.modules, false);
  const next = publishable(box.dir, { version: '2.0.0' });

  await assert.rejects(() => addModule(next, box.modules, false), /already installed[\s\S]*--force/);
  // A type rather than a message, because two callers have to tell this
  // failure apart from every other one: the CLI to name --force, the daemon to
  // answer 409 so the admin surface can offer to replace.
  await assert.rejects(() => addModule(next, box.modules, false), (err) => {
    assert.ok(err instanceof ModuleAlreadyAddedError);
    assert.equal(err.id, 'reports');
    assert.equal(err.installed, '1.0.0');
    return true;
  });

  const forced = await addModule(next, box.modules, true);
  assert.equal(forced.replaced, '1.0.0');
  assert.equal(readProvenance(box.modules).reports.version, '2.0.0');
});

test('a file the new version dropped does not survive the replace', async (t) => {
  const box = sandbox(t);
  const first = publishable(box.dir, { version: '1.0.0' });
  writeFileSync(join(first, 'dist', 'gone.js'), 'export default {};\n');
  await addModule(first, box.modules, false);
  assert.ok(readFileSync(join(box.modules, 'reports', 'dist', 'gone.js'), 'utf8'));

  await addModule(publishable(box.dir, { version: '2.0.0' }), box.modules, true);

  // Left behind, it would keep being importable and keep being imported.
  assert.throws(() => readFileSync(join(box.modules, 'reports', 'dist', 'gone.js'), 'utf8'), /ENOENT/);
});

// ---------------------------------------------------------------- remove

test('remove deletes the files and the ledger entry that described them', async (t) => {
  const box = sandbox(t);
  await addModule(publishable(box.dir), box.modules, false);

  const result = removeModule('reports', box.modules);

  assert.equal(result.removed, true);
  assert.equal(result.provenance.name, 'companion-module-reports');
  assert.equal(existsSync(join(box.modules, 'reports')), false, 'the next boot would scan it straight back in');
  assert.deepEqual(readProvenance(box.modules), {}, 'a ledger entry for files that are gone is a lie');
});

test('remove leaves its neighbours alone', async (t) => {
  const box = sandbox(t);
  await addModule(publishable(box.dir, { id: 'reports' }), box.modules, false);
  await addModule(publishable(box.dir, { id: 'billing' }), box.modules, false);

  removeModule('reports', box.modules);

  assert.equal(existsSync(join(box.modules, 'billing')), true);
  assert.deepEqual(Object.keys(readProvenance(box.modules)), ['billing']);
});

test('remove refuses anything that is not a module id, before it joins a path', (t) => {
  const box = sandbox(t);
  mkdirSync(join(box.dir, 'sibling'), { recursive: true });
  writeFileSync(join(box.dir, 'sibling', 'keep.txt'), 'x');
  mkdirSync(box.modules, { recursive: true });

  for (const id of ['../sibling', '..', '.', '/etc', 'a/b', 'Reports', '', '-x']) {
    assert.throws(() => removeModule(id, box.modules), /is not a module id/, `accepted '${id}'`);
  }
  assert.equal(existsSync(join(box.dir, 'sibling', 'keep.txt')), true, 'an id from a URL decides what gets deleted');
});

test('removing something that is not there deletes nothing and says so', (t) => {
  const box = sandbox(t);
  mkdirSync(box.modules, { recursive: true });

  const result = removeModule('never-added', box.modules);

  assert.equal(result.removed, false);
  assert.equal(result.provenance, null);
});

// ---------------------------------------------------------------- listing

test('the artifact list reports what is on disk, with and without provenance', async (t) => {
  const box = sandbox(t);
  const source = publishable(box.dir, { id: 'reports' });
  await addModule(source, box.modules, false);
  // The other way modules arrive: someone copied a directory in by hand.
  mkdirSync(join(box.modules, 'byhand'), { recursive: true });
  writeFileSync(
    join(box.modules, 'byhand', 'package.json'),
    JSON.stringify({ name: 'companion-module-byhand', version: '9.9.9' }),
  );

  const artifacts = listModuleArtifacts(box.modules).sort((a, b) => a.id.localeCompare(b.id));

  assert.deepEqual(artifacts.map((a) => a.id), ['byhand', 'reports']);
  assert.equal(artifacts[0].version, '9.9.9');
  assert.equal(artifacts[0].provenance, null, 'hand-copied files have no origin to report, and must not invent one');
  assert.equal(artifacts[1].version, '1.0.0');
  assert.equal(artifacts[1].provenance.spec, source, 'the answer to "where did this come from"');
  assert.match(artifacts[1].provenance.integrity, /^sha\d+-/);
});

// ---------------------------------------------------------------- spec policy

test('a spec from the UI must name a registry package, not a path or a git remote', () => {
  for (const ok of [
    'companion-module-reports',
    'companion-module-reports@1.2.0',
    'companion-module-reports@latest',
    '@acme/companion-module-reports',
    '@acme/companion-module-reports@^1.2.0',
    '@acme/reports@>=1.0.0 <2.0.0',
  ]) {
    assert.equal(isRegistrySpec(ok), true, `rejected '${ok}'`);
  }

  for (const bad of [
    // A path spec turns "add a module" into "copy any directory the daemon can read".
    '.',
    './build',
    '../../etc',
    '/var/tmp/evil',
    '~/evil',
    'file:./evil',
    'reports@file:.',
    // npm BUILDS a git spec, which runs `prepare` as the daemon user before
    // anything has been verified.
    'git+ssh://git@github.com/acme/evil.git',
    'github:acme/evil',
    'acme/evil',
    'https://example.com/evil.tgz',
    // An alias resolves to a different package than the one it names.
    'reports@npm:something-else',
    // argv that npm would read as a flag rather than a package.
    '--registry=http://evil',
    '-x',
    '',
  ]) {
    assert.equal(isRegistrySpec(bad), false, `accepted '${bad}'`);
  }
});
