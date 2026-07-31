import { useState } from 'react';
import { useAuth } from '@companion/module-core/client';
import type { Permission } from '@moxxy/companion-contracts';
import type { PrActionId, StepRemedy } from '../../contract/index.js';
import { codeApi as api } from '../api.js';

/**
 * The one place that knows how to perform an action on a pull request, and what
 * it costs to be allowed to.
 *
 * Everything that offers these verbs resolves them here: the PR page, a failed
 * gate's suggested fix, and the bulk bar. Keeping the mapping in one table is
 * the point — three copies would answer "what may this user do" differently and
 * only one of them would be right.
 */
export const PR_ACTIONS: Record<
  PrActionId,
  { label: string; permission: Permission; run: (repo: string, number: number) => Promise<unknown> }
> = {
  'pr.rerun-failed': {
    label: 'Re-run failed jobs',
    permission: 'prs:act',
    run: (repo, n) => api.rerunChecks(repo, n, 'failed'),
  },
  'pr.rerun-all': {
    label: 'Re-run all jobs',
    permission: 'prs:act',
    run: (repo, n) => api.rerunChecks(repo, n, 'all'),
  },
  'pr.mark-ready': {
    label: 'Mark ready for review',
    permission: 'prs:act',
    run: (repo, n) => api.markPrReady(repo, n),
  },
  'pr.update-branch': {
    label: 'Update branch',
    permission: 'prs:act',
    run: (repo, n) => api.updatePrBranch(repo, n),
  },
  'pr.fix-checks': {
    label: 'Repair failing checks',
    permission: 'prs:act',
    run: (repo, n) => api.fixChecks(repo, n),
  },
  'pr.analyze-checks': {
    label: 'Investigate failures with AI',
    permission: 'prs:act',
    run: (repo, n) => api.analyzeFailedChecks(repo, n),
  },
  'pr.resolve-conflicts': {
    label: 'Resolve conflicts',
    permission: 'prs:act',
    run: (repo, n) => api.resolveConflicts(repo, n),
  },
  'pr.address-reviews': {
    label: 'Address review feedback',
    permission: 'prs:act',
    run: (repo, n) => api.addressReviews(repo, n),
  },
};

/**
 * Buttons for what a failed step says can be done about it.
 *
 * The step chose these at run time from what it actually found, so a draft PR
 * and a stale one offer different fixes even though they failed the same gate.
 */
export function StepRemedies({
  remedies,
  repo,
  number,
}: {
  remedies: ReadonlyArray<StepRemedy>;
  repo: string;
  number: number;
}): JSX.Element | null {
  const { can } = useAuth();
  const [busy, setBusy] = useState<PrActionId | null>(null);
  const [done, setDone] = useState<PrActionId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const allowed = remedies.filter((r) => PR_ACTIONS[r.action] && can(PR_ACTIONS[r.action].permission));
  if (allowed.length === 0) return null;

  const fire = (r: StepRemedy): void => {
    setBusy(r.action);
    setError(null);
    void PR_ACTIONS[r.action]
      .run(repo, number)
      .then(() => setDone(r.action))
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setBusy(null));
  };

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {allowed.map((r) => (
        <button
          key={r.action}
          className="btn-ghost text-xs"
          disabled={busy !== null || done === r.action}
          onClick={() => fire(r)}
        >
          {busy === r.action ? 'Working…' : done === r.action ? 'Started' : r.label}
        </button>
      ))}
      {error ? <span className="text-xs text-red-500">{error}</span> : null}
      {done ? <span className="dim text-xs">re-run the pipeline once it settles</span> : null}
    </div>
  );
}
