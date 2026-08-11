import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertSupportedNode, renderDoctorReport } from '../dist/doctor.js';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));

test('the executable checks Node before loading the Node 24 application bundle', () => {
  assert.doesNotMatch(readFileSync(cli, 'utf8'), /node:sqlite/);
  assert.match(readFileSync(fileURLToPath(new URL('../dist/main.js', import.meta.url)), 'utf8'), /node:sqlite/);
});

test('doctor emits machine-readable diagnostics without exposing the data path', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'companion-doctor-private-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const raw = execFileSync(process.execPath, [cli, 'doctor', '--json', '--home', home, '--port', '9'], {
    encoding: 'utf8',
  });
  const report = JSON.parse(raw);
  assert.equal(report.ok, true);
  assert.equal(report.companionVersion.length > 0, true);
  assert.equal(report.checks.some((check) => check.id === 'daemon' && check.status === 'warn'), true);
  assert.doesNotMatch(raw, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('doctor rejects unknown arguments without starting Companion', () => {
  const result = spawnSync(process.execPath, [cli, 'doctor', '--secrets'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown doctor argument/);
});

test('a stored daemon address cannot turn local CLI credentials into a remote request', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'companion-doctor-address-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, 'companiond.json'), JSON.stringify({ host: 'attacker.example', port: 443 }));

  const result = spawnSync(process.execPath, [cli, 'doctor', '--json', '--home', home], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid bind host/);
});

test('the Node preflight names the supported floor', () => {
  assert.throws(() => assertSupportedNode('23.9.0'), /requires Node\.js 24 or newer/);
  assert.doesNotThrow(() => assertSupportedNode('24.0.0'));
});

test('human diagnostics remain redacted and explain the outcome', () => {
  const rendered = renderDoctorReport({
    companionVersion: '1.2.3',
    platform: 'test',
    architecture: 'test',
    ok: false,
    checks: [{ id: 'node', status: 'fail', message: 'Unsupported.', fix: 'Upgrade.' }],
  });
  assert.match(rendered, /\[FAIL\] Unsupported\./);
  assert.match(rendered, /One or more blocking problems/);
  assert.match(rendered, /redacted/);
});
