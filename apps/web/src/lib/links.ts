import type { PipelineRunRecord, ReportRecord, RunRecord } from '@companion/contract';

/**
 * Where a thing opens in the SPA. The raw run transcript (#/runs/:id) is
 * audit-only, so these route to the work itself — never straight to a run.
 * Explicit "view run" affordances are the one exception and link there directly.
 */

export function runHref(run: Pick<RunRecord, 'id' | 'kind' | 'repo' | 'issueNumber'>): string {
  const { repo, issueNumber } = run;
  if (run.kind === 'triage' && repo && issueNumber != null) return `#/repos/${repo}/issues/${issueNumber}`;
  if (run.kind === 'report') return '#/digest';
  if (run.kind === 'analysis' && repo && issueNumber != null) return `#/repos/${repo}/prs/${issueNumber}`;
  // fix / implement / interactive — the PR-in-the-making outcome view.
  return `#/runs/${run.id}/preview`;
}

export function pipelineRunHref(p: Pick<PipelineRunRecord, 'target' | 'repo' | 'prNumber'>): string {
  if (p.target === 'platform') return '#/pipelines';
  if (p.target === 'issue') return `#/repos/${p.repo}/issues/${p.prNumber}`;
  return `#/repos/${p.repo}/prs/${p.prNumber}`;
}

export function reportHref(r: Pick<ReportRecord, 'kind' | 'repo' | 'issueNumber'>): string {
  if (r.kind === 'ci-analysis' && r.repo && r.issueNumber) return `#/repos/${r.repo}/prs/${r.issueNumber}`;
  if (r.kind === 'digest') return '#/digest';
  return '#/automations';
}
