import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAnchorIndex, checkAnchor, unifiedDiffFromPatches } from '../dist/contract/diff-anchors.js';

/**
 * Hunk arithmetic is the load-bearing part: an off-by-one here posts a review
 * comment against the wrong line of somebody's pull request, which is worse
 * than posting none. Every counter transition gets a case.
 */
const DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,7 +10,8 @@ function boot() {
 const config = load();
-const port = config.port;
+const port = config.port ?? 3000;
+const host = config.host;
 start(port);

 log('up');
diff --git a/README.md b/README.md
index 3333333..4444444 100644
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 # Companion
+Docs.
`;

test('context lines advance both sides', () => {
  const idx = buildAnchorIndex(DIFF);
  // First context line of the hunk sits at old 10 and new 10.
  assert.equal(idx.lineText('src/app.ts', 'LEFT', 10), 'const config = load();');
  assert.equal(idx.lineText('src/app.ts', 'RIGHT', 10), 'const config = load();');
});

test('a deletion advances only the left side', () => {
  const idx = buildAnchorIndex(DIFF);
  assert.equal(idx.lineText('src/app.ts', 'LEFT', 11), 'const port = config.port;');
  assert.equal(idx.has('src/app.ts', 'RIGHT', 11), true); // the first addition
  assert.equal(idx.lineText('src/app.ts', 'RIGHT', 11), 'const port = config.port ?? 3000;');
});

test('additions advance only the right side, and context resumes offset', () => {
  const idx = buildAnchorIndex(DIFF);
  assert.equal(idx.lineText('src/app.ts', 'RIGHT', 12), 'const host = config.host;');
  // `start(port);` is old line 12 but new line 13 after the net +1.
  assert.equal(idx.lineText('src/app.ts', 'LEFT', 12), 'start(port);');
  assert.equal(idx.lineText('src/app.ts', 'RIGHT', 13), 'start(port);');
});

test('an empty context line carries no leading space and still counts', () => {
  const idx = buildAnchorIndex(DIFF);
  assert.equal(idx.lineText('src/app.ts', 'RIGHT', 14), '');
  assert.equal(idx.lineText('src/app.ts', 'RIGHT', 15), "log('up');");
});

test('a hunk header without a count means one line', () => {
  const idx = buildAnchorIndex(DIFF);
  assert.equal(idx.lineText('README.md', 'LEFT', 1), '# Companion');
  assert.equal(idx.lineText('README.md', 'RIGHT', 2), 'Docs.');
});

test('files are indexed separately', () => {
  const idx = buildAnchorIndex(DIFF);
  assert.deepEqual(idx.files(), ['src/app.ts', 'README.md']);
  assert.equal(idx.has('README.md', 'RIGHT', 13), false);
});

test('off-diff and unknown-file are distinguished', () => {
  const idx = buildAnchorIndex(DIFF);
  const anchor = (file, line) => ({ file, side: 'RIGHT', line, startLine: null });
  assert.equal(checkAnchor(idx, anchor('src/app.ts', 12)), null);
  assert.equal(checkAnchor(idx, anchor('src/app.ts', 900)), 'off-diff');
  assert.equal(checkAnchor(idx, anchor('src/never-touched.ts', 3)), 'unknown-file');
});

test('a quoted line that disagrees with the diff is a mismatch', () => {
  const idx = buildAnchorIndex(DIFF);
  const anchor = { file: 'src/app.ts', side: 'RIGHT', line: 12, startLine: null };
  assert.equal(checkAnchor(idx, anchor, 'const host = config.host;'), null);
  // Re-indentation must not discard a real finding.
  assert.equal(checkAnchor(idx, anchor, '   const host   = config.host;'), null);
  assert.equal(checkAnchor(idx, anchor, 'const nothing = like.this;'), 'text-mismatch');
});

test('a multi-line range must be wholly inside the diff', () => {
  const idx = buildAnchorIndex(DIFF);
  const range = (startLine, line) => ({ file: 'src/app.ts', side: 'RIGHT', line, startLine });
  assert.equal(checkAnchor(idx, range(11, 12)), null);
  assert.equal(checkAnchor(idx, range(12, 11)), 'bad-range');
  assert.equal(checkAnchor(idx, range(11, 900)), 'off-diff');
});

test('a rename resolves under either path', () => {
  const idx = buildAnchorIndex(`diff --git a/old/name.ts b/new/name.ts
--- a/old/name.ts
+++ b/new/name.ts
@@ -1,2 +1,2 @@
 keep();
-drop();
+add();
`);
  assert.equal(idx.lineText('new/name.ts', 'RIGHT', 2), 'add();');
  assert.equal(idx.lineText('old/name.ts', 'LEFT', 2), 'drop();');
});

test('a git header with delimiter-like path text keeps the final delimiter', () => {
  const idx = buildAnchorIndex(`diff --git a/dir b/old.ts b/new.ts
--- a/dir b/old.ts
+++ b/new.ts
@@ -1 +1 @@
-old
+new
`);
  assert.equal(idx.lineText('dir b/old.ts', 'LEFT', 1), 'old');
  assert.equal(idx.lineText('new.ts', 'RIGHT', 1), 'new');
});

test('"no newline at end of file" advances neither counter', () => {
  const idx = buildAnchorIndex(`diff --git a/x.txt b/x.txt
--- a/x.txt
+++ b/x.txt
@@ -1,2 +1,2 @@
 first
-second
\\ No newline at end of file
+second!
\\ No newline at end of file
`);
  assert.equal(idx.lineText('x.txt', 'RIGHT', 2), 'second!');
  assert.equal(idx.has('x.txt', 'RIGHT', 3), false);
});

test('a patch with no git header is still indexable', () => {
  const idx = buildAnchorIndex(`@@ -1,1 +1,2 @@
 alpha
+beta
`);
  assert.equal(idx.lineText('', 'RIGHT', 2), 'beta');
});

test('excerpt returns the anchored line in context', () => {
  const idx = buildAnchorIndex(DIFF);
  const text = idx.excerpt('src/app.ts', 'RIGHT', 12, 1);
  assert.ok(text.includes('+const host = config.host;'));
  assert.ok(text.includes('+const port = config.port ?? 3000;'));
});

test('patches without a body are skipped when reassembling', () => {
  const diff = unifiedDiffFromPatches([
    { filename: 'a.ts', previousFilename: null, patch: '@@ -1 +1 @@\n-a\n+b' },
    { filename: 'logo.png', previousFilename: null, patch: null },
  ]);
  const idx = buildAnchorIndex(diff);
  assert.deepEqual(idx.files(), ['a.ts']);
  assert.equal(idx.lineText('a.ts', 'RIGHT', 1), 'b');
});
