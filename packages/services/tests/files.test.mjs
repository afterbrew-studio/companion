import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readRegularTextFile, writePrivateTextFile } from '../dist/index.js';

function files(t) {
  const dir = mkdtempSync(join(tmpdir(), 'companion-files-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file: join(dir, 'credential') };
}

test('private writes replace a symlink instead of following it', (t) => {
  const { dir, file } = files(t);
  const outside = join(dir, 'outside');
  writeFileSync(outside, 'do not replace');
  symlinkSync(outside, file);

  writePrivateTextFile(file, 'new credential\n');

  assert.equal(readFileSync(outside, 'utf8'), 'do not replace');
  assert.equal(readFileSync(file, 'utf8'), 'new credential\n');
  assert.equal(lstatSync(file).isSymbolicLink(), false);
  assert.equal(lstatSync(file).mode & 0o777, 0o600);
});

test('regular reads reject symlinks and oversized files', (t) => {
  const { dir, file } = files(t);
  const outside = join(dir, 'outside');
  writeFileSync(outside, 'secret');
  symlinkSync(outside, file);
  assert.throws(() => readRegularTextFile(file), /ELOOP|symbolic link/i);

  rmSync(file);
  writeFileSync(file, '12345');
  assert.throws(() => readRegularTextFile(file, { maxBytes: 4 }), /exceeds 4 bytes/);
});
