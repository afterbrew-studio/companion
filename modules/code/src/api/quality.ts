import type { AgentQualityStat } from '../contract/index.js';

/** Raw outcome counts one table's aggregate returns. */
export interface OutcomeCounts {
  accepted: number;
  rejected: number;
  pending: number;
  failed: number;
  cancelled: number;
}

export const EMPTY_OUTCOMES: OutcomeCounts = { accepted: 0, rejected: 0, pending: 0, failed: 0, cancelled: 0 };

/**
 * The SQL every outcome aggregate shares. Grouping in SQL matters here: these
 * tables grow with every issue and pull request touched, and pulling rows into
 * JS to count them would make a quality page get slower the more the instance is
 * used, which is exactly backwards.
 *
 * Callers pass their OWN table name; nothing here is interpolated from a request.
 */
export function outcomeSql(table: 'triage_results' | 'pr_reviews'): string {
  // A cancelled review may never have left the queue and therefore has no run
  // id. `source` is the durable distinction for review rows; triage has no
  // human-draft shape and keeps its legacy non-empty-run predicate.
  const agentOnly = table === 'pr_reviews' ? `t.source = 'agent'` : `t.run_id != ''`;
  return `SELECT status, COUNT(*) AS n FROM ${table} t
          JOIN v_repos r ON r.full_name = t.repo
          WHERE r.workspace_id = ? AND t.created_at >= ? AND ${agentOnly}
          GROUP BY status`;
}

export function toCounts(rows: ReadonlyArray<{ status: string; n: number }>): OutcomeCounts {
  const counts = { ...EMPTY_OUTCOMES };
  for (const row of rows) {
    if (row.status === 'applied') counts.accepted += row.n;
    else if (row.status === 'dismissed') counts.rejected += row.n;
    else if (row.status === 'failed') counts.failed += row.n;
    else if (row.status === 'cancelled') counts.cancelled += row.n;
    // 'pending' and anything a later status adds count as undecided rather than
    // being silently folded into a rate they did not contribute to.
    else counts.pending += row.n;
  }
  return counts;
}

/**
 * Turn counts into the reported stat.
 *
 * The rate deliberately excludes pending and failed. Pending is undecided, and
 * counting it either way would make the number move as a backlog drains rather
 * than as quality changes. Failed is a reliability problem, reported next to the
 * rate instead of inside it: an agent that crashes is not an agent whose
 * judgement was rejected.
 */
export function toStat(
  surface: string,
  label: string,
  counts: OutcomeCounts,
  overridden: number | null = null,
): AgentQualityStat {
  const decided = counts.accepted + counts.rejected;
  return {
    surface,
    label,
    accepted: counts.accepted,
    rejected: counts.rejected,
    pending: counts.pending,
    failed: counts.failed,
    cancelled: counts.cancelled,
    acceptanceRate: decided === 0 ? null : counts.accepted / decided,
    overridden,
  };
}
