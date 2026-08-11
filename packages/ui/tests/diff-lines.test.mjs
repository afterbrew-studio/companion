import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDiff } from './dist/diff-view.js';

/**
 * The renderer numbers diff lines a second time, independently of whatever
 * computed the anchors it is asked to display. If the two ever disagree, an
 * annotation is drawn against one line and posted against another — the worst
 * failure this feature has, and a silent one.
 *
 * So this fixture and its expected numbers are deliberately IDENTICAL to the
 * ones in modules/code/tests/diff-anchors.test.mjs. Both sides asserting the
 * same answers on the same input is what keeps them in step; changing one
 * without the other fails here.
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

/** Every source line of a file, addressed the way an annotation addresses it. */
function sideLines(file, side) {
  const out = new Map();
  for (const line of file.lines) {
    if (line.kind === 'hunk' || line.kind === 'meta') continue;
    const n = side === 'LEFT' ? line.oldLine : line.newLine;
    if (n !== null) out.set(n, line.text.slice(1));
  }
  return out;
}

test('context lines are numbered on both sides', () => {
  const [app] = parseDiff(DIFF);
  assert.equal(sideLines(app, 'LEFT').get(10), 'const config = load();');
  assert.equal(sideLines(app, 'RIGHT').get(10), 'const config = load();');
});

test('a deletion numbers only the left side', () => {
  const [app] = parseDiff(DIFF);
  assert.equal(sideLines(app, 'LEFT').get(11), 'const port = config.port;');
  assert.equal(sideLines(app, 'RIGHT').get(11), 'const port = config.port ?? 3000;');
});

test('additions offset the right side for the rest of the hunk', () => {
  const [app] = parseDiff(DIFF);
  assert.equal(sideLines(app, 'RIGHT').get(12), 'const host = config.host;');
  assert.equal(sideLines(app, 'LEFT').get(12), 'start(port);');
  assert.equal(sideLines(app, 'RIGHT').get(13), 'start(port);');
});

test('an empty context line still occupies a number', () => {
  const [app] = parseDiff(DIFF);
  assert.equal(sideLines(app, 'RIGHT').get(14), '');
  assert.equal(sideLines(app, 'RIGHT').get(15), "log('up');");
});

test('a hunk header without a count means one line', () => {
  const [, readme] = parseDiff(DIFF);
  assert.equal(sideLines(readme, 'LEFT').get(1), '# Companion');
  assert.equal(sideLines(readme, 'RIGHT').get(2), 'Docs.');
});

test('the trailing newline does not invent a final line', () => {
  const [, readme] = parseDiff(DIFF);
  assert.equal(sideLines(readme, 'RIGHT').has(3), false);
});

test('a rename records both paths so either resolves', () => {
  const [file] = parseDiff(`diff --git a/old/name.ts b/new/name.ts
--- a/old/name.ts
+++ b/new/name.ts
@@ -1,2 +1,2 @@
 keep();
-drop();
+add();
`);
  assert.equal(file.path, 'new/name.ts');
  assert.equal(file.fromPath, 'old/name.ts');
  assert.equal(sideLines(file, 'RIGHT').get(2), 'add();');
  assert.equal(sideLines(file, 'LEFT').get(2), 'drop();');
});

test('a git header with delimiter-like path text keeps the final delimiter', () => {
  const [file] = parseDiff(`diff --git a/dir b/old.ts b/new.ts
--- a/dir b/old.ts
+++ b/new.ts
@@ -1 +1 @@
-old
+new
`);
  assert.equal(file.fromPath, 'dir b/old.ts');
  assert.equal(file.path, 'new.ts');
});

test('"no newline at end of file" consumes no line number', () => {
  const [file] = parseDiff(`diff --git a/x.txt b/x.txt
--- a/x.txt
+++ b/x.txt
@@ -1,2 +1,2 @@
 first
-second
\\ No newline at end of file
+second!
\\ No newline at end of file
`);
  assert.equal(sideLines(file, 'RIGHT').get(2), 'second!');
  assert.equal(sideLines(file, 'RIGHT').has(3), false);
});
