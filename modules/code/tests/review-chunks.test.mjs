import assert from 'node:assert/strict';
import test from 'node:test';
import { planReview, planReviewChunks } from '../dist/contract/review-chunks.js';
import { fileChangeSizes } from '../dist/contract/diff-anchors.js';

/**
 * The split decides how much one agent has to hold at once, and holding too
 * much fails silently: a verdict still arrives, it is just invented about the
 * files that fell out of context. So every rule that bounds a pass gets a case.
 */

const file = (path, changed) => ({ path, changed });

test('a pull request inside the budget is one pass', () => {
  assert.deepEqual(planReview([file('a.ts', 100), file('b.ts', 200)], { budget: 1000 }), { kind: 'single' });
});

test('files fill a pass up to the budget and then start another', () => {
  const chunks = planReviewChunks([file('a.ts', 600), file('b.ts', 600), file('c.ts', 300)], 1000);
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[0].paths, ['a.ts']);
  assert.deepEqual(chunks[1].paths, ['b.ts', 'c.ts']);
});

test('a file larger than the whole budget gets a pass to itself', () => {
  // Splitting it would review half a file out of context, which is where false
  // findings come from; sharing a pass would spend the budget it already blew.
  const chunks = planReviewChunks([file('a.ts', 50), file('huge.ts', 5000), file('z.ts', 50)], 1000);
  assert.deepEqual(
    chunks.map((c) => c.paths),
    [['a.ts'], ['huge.ts'], ['z.ts']],
  );
});

test('one oversized file is refused instead of masquerading as one safe pass', () => {
  assert.deepEqual(planReview([file('generated.ts', 5000)], { budget: 1000 }), {
    kind: 'too-large',
    chunks: 1,
    changed: 5000,
  });
});

test('neighbouring files land together, so each is context for the others', () => {
  const chunks = planReviewChunks(
    [file('web/z.ts', 400), file('api/a.ts', 400), file('api/b.ts', 400)],
    900,
  );
  assert.deepEqual(chunks[0].paths, ['api/a.ts', 'api/b.ts']);
  assert.deepEqual(chunks[1].paths, ['web/z.ts']);
});

test('files with nothing changed are not reviewed', () => {
  // A rename with no edits, or a mode change: there is no diff to read.
  assert.deepEqual(planReviewChunks([file('moved.ts', 0), file('a.ts', 10)], 1000)[0].paths, ['a.ts']);
});

test('past the chunk ceiling it refuses rather than half-reviewing', () => {
  const many = Array.from({ length: 40 }, (_, i) => file(`f${String(i).padStart(2, '0')}.ts`, 900));
  const plan = planReview(many, { budget: 1000, maxChunks: 12 });
  assert.equal(plan.kind, 'too-large');
  assert.equal(plan.chunks, 40);
  assert.equal(plan.changed, 40 * 900);
});

test('every changed file appears in exactly one pass', () => {
  const files = Array.from({ length: 25 }, (_, i) => file(`f${String(i).padStart(2, '0')}.ts`, 100 + i));
  const chunks = planReviewChunks(files, 500);
  const seen = chunks.flatMap((c) => c.paths);
  assert.equal(seen.length, new Set(seen).size, 'a file was reviewed twice');
  assert.deepEqual(seen.sort(), files.map((f) => f.path).sort());
});

test('a chunk reports the work it holds', () => {
  const chunks = planReviewChunks([file('a.ts', 300), file('b.ts', 200)], 1000);
  assert.equal(chunks[0].changed, 500);
});

// ---------- sizes come from the same diff the anchors do ----------

test('change size counts edits, not the context around them', () => {
  const sizes = fileChangeSizes(`diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,4 +10,4 @@
 kept();
-gone();
+added();
 kept();
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 # Title
+Line.
`);
  assert.deepEqual(sizes, [
    { path: 'src/app.ts', changed: 2 },
    { path: 'README.md', changed: 1 },
  ]);
});

test('"no newline at end of file" is not an edit', () => {
  const sizes = fileChangeSizes(`diff --git a/x.txt b/x.txt
--- a/x.txt
+++ b/x.txt
@@ -1,2 +1,2 @@
 first
-second
\\ No newline at end of file
+second!
\\ No newline at end of file
`);
  assert.deepEqual(sizes, [{ path: 'x.txt', changed: 2 }]);
});
