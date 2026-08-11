import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import migrations from '../dist/api/migrations.js';
import { PrReviewsStore } from '../dist/api/pr-reviews-store.js';
import { TriageStore } from '../dist/api/triage-store.js';
import { PipelinesStore } from '../dist/api/pipelines-store.js';

const DAY = 24 * 60 * 60_000;
const OLD = Date.now() - 400 * DAY;

function fixture() {
  const db = new Database(':memory:');
  for (const m of migrations) m.up(db);
  return db;
}

function seedReview(db, id, repo, prNumber, createdAt, status = 'pending') {
  db.prepare(
    `INSERT INTO pr_reviews (id, repo, pr_number, run_id, status, created_at)
     VALUES (?, ?, ?, '', ?, ?)`,
  ).run(id, repo, prNumber, status, createdAt);
}

function seedFinding(db, id, reviewId) {
  db.prepare(
    `INSERT INTO pr_review_findings (id, review_id, title, created_at) VALUES (?, ?, 'finding', ?)`,
  ).run(id, reviewId, OLD);
}

test('review prune deletes superseded old rows with findings, never the latest per PR', () => {
  const db = fixture();
  const store = new PrReviewsStore(db);
  // PR 1: two ancient reviews + one fresh — only the ancient superseded one goes.
  seedReview(db, 'r-old-superseded', 'acme/app', 1, OLD);
  seedFinding(db, 'f-1', 'r-old-superseded');
  seedReview(db, 'r-old-mid', 'acme/app', 1, OLD + 1);
  seedReview(db, 'r-fresh', 'acme/app', 1, Date.now());
  // PR 2: its ONLY review is ancient — the latest per PR survives any age.
  seedReview(db, 'r-ancient-latest', 'acme/app', 2, OLD);
  // PR 3: an ancient running row is never touched, even when superseded.
  seedReview(db, 'r-ancient-running', 'acme/app', 3, OLD, 'running');
  seedReview(db, 'r-3-fresh', 'acme/app', 3, Date.now());

  const removed = store.prune(180 * DAY);
  assert.equal(removed, 2);
  const ids = db.prepare(`SELECT id FROM pr_reviews ORDER BY id`).all().map((r) => r.id);
  assert.deepEqual(ids, ['r-3-fresh', 'r-ancient-latest', 'r-ancient-running', 'r-fresh']);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM pr_review_findings`).get().n, 0);
  db.close();
});

test('review prune is bounded per sweep and converges across runs', () => {
  const db = fixture();
  const store = new PrReviewsStore(db);
  for (let i = 0; i < 7; i += 1) seedReview(db, `r-${i}`, 'acme/app', 9, OLD + i);
  seedReview(db, 'r-latest', 'acme/app', 9, Date.now());

  assert.equal(store.prune(180 * DAY, 3), 3);
  assert.equal(store.prune(180 * DAY, 3), 3);
  assert.equal(store.prune(180 * DAY, 3), 1);
  assert.equal(store.prune(180 * DAY, 3), 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM pr_reviews`).get().n, 1);
  db.close();
});

test('triage prune keeps the newest verdict per issue regardless of age', () => {
  const db = fixture();
  const store = new TriageStore(db);
  const seed = (id, issue, createdAt, status = 'pending') =>
    db
      .prepare(
        `INSERT INTO triage_results (id, repo, issue_number, run_id, status, created_at)
         VALUES (?, 'acme/app', ?, 'run', ?, ?)`,
      )
      .run(id, issue, status, createdAt);
  seed('t-superseded', 5, OLD);
  seed('t-latest-ancient', 5, OLD + 1);
  seed('t-only', 6, OLD);
  seed('t-running-old', 7, OLD, 'running');
  seed('t-7-fresh', 7, Date.now());

  assert.equal(store.prune(180 * DAY), 1);
  const ids = db.prepare(`SELECT id FROM triage_results ORDER BY id`).all().map((r) => r.id);
  assert.deepEqual(ids, ['t-7-fresh', 't-latest-ancient', 't-only', 't-running-old']);
  db.close();
});

test('pipeline run prune keeps the newest run per repo/number/target', () => {
  const db = fixture();
  const store = new PipelinesStore(db);
  const seed = (id, prNumber, target, createdAt, status = 'passed') =>
    db
      .prepare(
        `INSERT INTO pipeline_runs (id, pipeline_id, pipeline_name, repo, pr_number, target, status, trigger, created_at)
         VALUES (?, 'pl-1', 'Checks', 'acme/app', ?, ?, ?, 'manual', ?)`,
      )
      .run(id, prNumber, target, status, createdAt);
  seed('p-superseded', 4, 'pr', OLD);
  seed('p-latest-ancient', 4, 'pr', OLD + 1);
  // Same number, other target: its own newest survives independently.
  seed('p-issue-only', 4, 'issue', OLD);
  seed('p-running-old', 8, 'pr', OLD, 'running');
  seed('p-8-fresh', 8, 'pr', Date.now());

  assert.equal(store.pruneRuns(180 * DAY), 1);
  const ids = db.prepare(`SELECT id FROM pipeline_runs ORDER BY id`).all().map((r) => r.id);
  assert.deepEqual(ids, ['p-8-fresh', 'p-issue-only', 'p-latest-ancient', 'p-running-old']);
  db.close();
});
