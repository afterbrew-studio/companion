import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addModule, readProvenance } from '../dist/module-add.js';
import { parseModuleCommand } from '../dist/modules.js';

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

test('add fetches, unpacks and records where the module came from', (t) => {
  const box = sandbox(t);
  const source = publishable(box.dir);

  const result = addModule(source, box.modules, false);

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

test('a module that fails the ABI check never reaches the modules directory', (t) => {
  const box = sandbox(t);
  // Importing outside the ABI is the failure `verify` exists to catch.
  const source = publishable(box.dir, { id: 'bad', api: "import x from 'left-pad';\nexport default {};\n" });

  assert.throws(
    () => addModule(source, box.modules, false),
    /not a loadable Companion module[\s\S]*left-pad/,
  );
  assert.deepEqual(readProvenance(box.modules), {}, 'a refused module must leave no trace');
});

test('a package with no moxxy block is refused as not a module', (t) => {
  const box = sandbox(t);
  const dir = join(box.dir, 'plain');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'plain', version: '1.0.0' }));

  assert.throws(() => addModule(dir, box.modules, false), /is not a Companion module/);
});

test('replacing an installed module needs --force, and then says what it replaced', (t) => {
  const box = sandbox(t);
  addModule(publishable(box.dir, { version: '1.0.0' }), box.modules, false);
  const next = publishable(box.dir, { version: '2.0.0' });

  assert.throws(() => addModule(next, box.modules, false), /already installed[\s\S]*--force/);

  const forced = addModule(next, box.modules, true);
  assert.equal(forced.replaced, '1.0.0');
  assert.equal(readProvenance(box.modules).reports.version, '2.0.0');
});

test('a file the new version dropped does not survive the replace', (t) => {
  const box = sandbox(t);
  const first = publishable(box.dir, { version: '1.0.0' });
  writeFileSync(join(first, 'dist', 'gone.js'), 'export default {};\n');
  addModule(first, box.modules, false);
  assert.ok(readFileSync(join(box.modules, 'reports', 'dist', 'gone.js'), 'utf8'));

  addModule(publishable(box.dir, { version: '2.0.0' }), box.modules, true);

  // Left behind, it would keep being importable and keep being imported.
  assert.throws(() => readFileSync(join(box.modules, 'reports', 'dist', 'gone.js'), 'utf8'), /ENOENT/);
});

test('add takes a spec rather than an id, and carries --force', () => {
  const cmd = parseModuleCommand(['add', 'companion-module-reports@1.2.0', '--force']);
  assert.equal(cmd.action, 'add');
  assert.equal(cmd.id, 'companion-module-reports@1.2.0');
  assert.equal(cmd.force, true);

  assert.throws(() => parseModuleCommand(['add']), /requires a package spec/);
});
