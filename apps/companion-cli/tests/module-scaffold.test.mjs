import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseModuleCommand, scaffoldModule } from '../dist/modules.js';

/**
 * The generator writes real files from the template bundled into dist/, so
 * these tests exercise exactly what a `companion module scaffold` user gets.
 */

function workdir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'companion-scaffold-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('scaffold takes a name and needs no daemon flags', () => {
  const cmd = parseModuleCommand(['scaffold', 'reports']);
  assert.equal(cmd.action, 'scaffold');
  assert.equal(cmd.id, 'reports');

  assert.throws(() => parseModuleCommand(['scaffold']), /requires a name/);
});

test('the generated package.json parses and carries the substituted identity', (t) => {
  const parent = workdir(t);
  const result = scaffoldModule('reports', parent);
  assert.equal(result.dir, join(parent, 'companion-module-reports'));
  assert.equal(result.id, 'reports');
  assert.equal(result.title, 'Reports');

  const pkg = JSON.parse(readFileSync(join(result.dir, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'companion-module-reports');
  assert.equal(pkg.moxxy.id, 'reports');
  assert.equal(pkg.moxxy.abi, '0.x');
  assert.equal(pkg.moxxy.manifest, './dist/module.js');
  assert.equal(pkg.moxxy.api, './dist/api.js');
  assert.equal(pkg.moxxy.client, './dist/client.js');
  // Outside the workspace `workspace:` cannot resolve; the template ships the
  // published ranges, resolved when the CLI package was built.
  const specs = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies });
  for (const [name, spec] of specs) {
    assert.ok(!String(spec).startsWith('workspace:'), `${name} still uses a workspace range: ${spec}`);
  }
});

test('the module id reaches the manifest, contract, routes and migration', (t) => {
  const parent = workdir(t);
  const { dir } = scaffoldModule('team-reports', parent);

  const manifest = readFileSync(join(dir, 'src/module.ts'), 'utf8');
  assert.match(manifest, /id: 'team-reports'/);
  assert.match(manifest, /title: 'Team Reports'/);

  const contract = readFileSync(join(dir, 'src/contract/index.ts'), 'utf8');
  assert.match(contract, /'team-reports:greet'/);
  assert.match(contract, /declare module '@moxxy\/companion-contracts'/);

  const routes = readFileSync(join(dir, 'src/api/routes.ts'), 'utf8');
  assert.match(routes, /\/api\/team-reports\/greetings/);

  // A dash is not valid in an unquoted SQL identifier, so the table name is
  // the underscore form of the id.
  const migrations = readFileSync(join(dir, 'src/api/migrations.ts'), 'utf8');
  assert.match(migrations, /team_reports_greetings/);
  assert.doesNotMatch(migrations, /team-reports_greetings/);
});

test('a bad name or an existing directory is refused before anything is written', (t) => {
  const parent = workdir(t);
  assert.throws(() => scaffoldModule('Bad_Name', parent), /kebab-case/);

  scaffoldModule('reports', parent);
  assert.throws(() => scaffoldModule('reports', parent), /already exists/);
  // The package-name prefix is accepted and stripped, so both spellings land
  // in the same place.
  assert.throws(() => scaffoldModule('companion-module-reports', parent), /already exists/);
  assert.ok(existsSync(join(parent, 'companion-module-reports', 'src/module.ts')));
});
