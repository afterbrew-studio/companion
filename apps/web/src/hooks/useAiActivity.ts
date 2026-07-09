import { useMemo } from 'react';
import { useRuns } from './useRuns.js';
import { useRunQueue } from './useRunQueue.js';

export type AiActivity = 'running' | 'queued';

/**
 * Which issues/PRs currently have an agent action running or waiting, keyed by
 * `owner/name#number`. Runs carry repo + issueNumber (PR reviews store the PR
 * number there, and GitHub numbers are unique per repo), so a row can look
 * itself up directly. `running` wins over `queued`.
 */
export function useAiActivity(): Map<string, AiActivity> {
  const { runs } = useRuns();
  const { entries } = useRunQueue();
  return useMemo(() => {
    const map = new Map<string, AiActivity>();
    for (const e of entries) {
      if (e.repo && e.issueNumber != null) map.set(`${e.repo}#${e.issueNumber}`, 'queued');
    }
    for (const r of runs) {
      if (r.repo && r.issueNumber != null && (r.status === 'running' || r.status === 'provisioning')) {
        map.set(`${r.repo}#${r.issueNumber}`, 'running');
      }
    }
    return map;
  }, [runs, entries]);
}
