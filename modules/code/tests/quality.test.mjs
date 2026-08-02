import assert from 'node:assert/strict';
import test from 'node:test';
import { EMPTY_OUTCOMES, outcomeSql, toCounts, toStat } from '../dist/api/quality.js';

const rows = (o) => Object.entries(o).map(([status, n]) => ({ status, n }));

// ---------- counting ----------

test('applied and dismissed are the two decisions', () => {
  const counts = toCounts(rows({ applied: 7, dismissed: 3 }));
  assert.equal(counts.accepted, 7);
  assert.equal(counts.rejected, 3);
});

test('failed is kept apart from rejected, because a crash is not a judgement', () => {
  const counts = toCounts(rows({ applied: 1, failed: 5 }));
  assert.equal(counts.rejected, 0);
  assert.equal(counts.failed, 5);
});

test('maintainer cancellation is neither pending nor a reliability failure', () => {
  const counts = toCounts(rows({ cancelled: 4, pending: 2 }));
  assert.equal(counts.cancelled, 4);
  assert.equal(counts.pending, 2);
  assert.equal(counts.failed, 0);
});

test('an unknown status counts as undecided rather than being dropped', () => {
  // A status added by a later migration must not silently vanish from the totals
  // or quietly inflate a rate it never contributed to.
  const counts = toCounts(rows({ applied: 1, something_new: 4 }));
  assert.equal(counts.pending, 4);
  assert.equal(counts.accepted, 1);
});

test('no rows is all zeroes, not a crash', () => {
  assert.deepEqual(toCounts([]), EMPTY_OUTCOMES);
});

// ---------- the rate ----------

test('the rate is over decided verdicts only, so a backlog cannot move it', () => {
  // 8 accepted, 2 rejected, 90 still waiting: 80%, not 8%.
  const stat = toStat('triage', 'Triage', { accepted: 8, rejected: 2, pending: 90, failed: 0, cancelled: 0 });
  assert.equal(stat.acceptanceRate, 0.8);
});

test('failures do not drag the rate down either', () => {
  const stat = toStat('triage', 'Triage', { accepted: 1, rejected: 0, pending: 0, failed: 99, cancelled: 0 });
  assert.equal(stat.acceptanceRate, 1);
  assert.equal(stat.failed, 99, 'but they are still reported, loudly');
});

test('nothing decided reports null rather than a flattering 100%', () => {
  // The whole point: a surface nobody has judged has no score, and inventing one
  // would be the single most misleading thing this page could do.
  const stat = toStat('triage', 'Triage', { accepted: 0, rejected: 0, pending: 12, failed: 0, cancelled: 0 });
  assert.equal(stat.acceptanceRate, null);
});

test('total rejection is 0, not null, which is a different statement', () => {
  const stat = toStat('triage', 'Triage', { accepted: 0, rejected: 5, pending: 0, failed: 0, cancelled: 0 });
  assert.equal(stat.acceptanceRate, 0);
});

test('overridden is null for a surface with no recommendation to override', () => {
  assert.equal(toStat('triage', 'Triage', EMPTY_OUTCOMES).overridden, null);
  assert.equal(toStat('slop', 'Slop', EMPTY_OUTCOMES, 4).overridden, 4);
});

// ---------- the query ----------

test('the aggregate groups in SQL and scopes through the published repo view', () => {
  const sql = outcomeSql('triage_results');
  assert.match(sql, /GROUP BY status/, 'counting in JS would get slower the more the instance is used');
  assert.match(sql, /JOIN v_repos/, 'workspace scoping never joins the repos table directly');
  assert.match(sql, /workspace_id = \?/);
  assert.match(sql, /created_at >= \?/);
});

test('the table name is the caller’s own, never interpolated from a request', () => {
  // Both call sites are stores naming the table they own; there is no third form.
  assert.match(outcomeSql('pr_reviews'), /FROM pr_reviews t/);
  assert.match(outcomeSql('triage_results'), /FROM triage_results t/);
});

test('a manual review draft is not counted as an agent verdict', () => {
  // A draft a person started carries no run. Counting one as accepted would
  // report the reviewer's own comments back to them as the agent's accuracy.
  assert.match(outcomeSql('pr_reviews'), /source = 'agent'/);
  assert.match(outcomeSql('triage_results'), /run_id != ''/);
});
