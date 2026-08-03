import { useCallback, useEffect, useRef, useState } from 'react';
import { onServerMessage } from '@moxxy/companion-sdk/client';
import { useAuth } from '@companion/module-core/client';
import type { IssueRecord, PipelineRunRecord, TriageResult } from '../../contract/index.js';
import { codeApi as api } from '../api.js';

/**
 * One issue's data and the actions on it — the live record + latest triage
 * verdict, an AI triage run, an agent fix (which navigates to the building
 * preview), and open/close. The detail page is presentation over this; the
 * triage-verdict card owns its own apply/dismiss.
 */
export interface UseIssue {
  readonly issue: IssueRecord | null;
  readonly triage: TriageResult | null;
  readonly pipelineRuns: PipelineRunRecord[];
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
  readonly canAct: boolean;
  readonly canReadRuns: boolean;
  readonly canUseAgents: boolean;
  readonly triaging: boolean;
  readonly startTriage: () => Promise<void>;
  readonly fixing: boolean;
  readonly startFix: () => Promise<void>;
  readonly busy: boolean;
  readonly setIssueState: (next: 'open' | 'closed') => Promise<void>;
}

export function useIssue(repo: string, number: number): UseIssue {
  const targetKey = `${repo}#${number}`;
  const { can } = useAuth();
  const canAct = can('issues:act');
  const canReadRuns = can('runs:read');
  const canUseAgents = canAct && canReadRuns && can('runs:act');
  const canReadPipelines = can('pipelines:read');
  const [issue, setIssue] = useState<IssueRecord | null>(null);
  const [triage, setTriage] = useState<TriageResult | null>(null);
  const [pipelineRuns, setPipelineRuns] = useState<PipelineRunRecord[]>([]);
  const [triaging, setTriaging] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorTarget, setErrorTarget] = useState<string | null>(null);
  const [dataTarget, setDataTarget] = useState<string | null>(null);
  const refreshGeneration = useRef(0);
  const currentTarget = useRef(targetKey);
  currentTarget.current = targetKey;

  const refresh = useCallback(async (): Promise<void> => {
    const request = ++refreshGeneration.current;
    try {
      const [detail, runs] = await Promise.allSettled([
        api.getIssue(repo, number),
        canReadPipelines ? api.issuePipelineRuns(repo, number) : Promise.resolve({ runs: [] }),
      ]);
      if (request !== refreshGeneration.current) return;
      if (detail.status === 'rejected') throw detail.reason;
      setIssue(detail.value.issue);
      setTriage(detail.value.triage);
      setTriaging(detail.value.triage?.status === 'running');
      setDataTarget(targetKey);
      if (runs.status === 'fulfilled') {
        setPipelineRuns(runs.value.runs);
        setError(null);
        setErrorTarget(null);
      } else {
        setError(`Could not refresh pipeline runs: ${String(runs.reason)}`);
        setErrorTarget(targetKey);
      }
    } catch (err) {
      if (request === refreshGeneration.current) {
        setError(String(err));
        setErrorTarget(targetKey);
      }
    }
  }, [repo, number, canReadPipelines, targetKey]);

  useEffect(() => {
    refreshGeneration.current++;
    setIssue(null);
    setTriage(null);
    setPipelineRuns([]);
    setDataTarget(null);
    setTriaging(false);
    setFixing(false);
    setBusy(false);
    setError(null);
    setErrorTarget(null);
    void refresh();
    return onServerMessage((msg) => {
      if (
        (msg.t === 'triage.changed' || msg.t === 'issues.changed' || msg.t === 'pipelineRuns.changed') &&
        msg.repo === repo
      )
        void refresh();
    });
  }, [refresh, repo]);

  const startTriage = async (): Promise<void> => {
    const actionTarget = targetKey;
    setTriaging(true);
    setError(null);
    setErrorTarget(null);
    try {
      await api.triageIssue(repo, number);
    } catch (err) {
      if (currentTarget.current !== actionTarget) return;
      setTriaging(false);
      setError(String(err));
      setErrorTarget(actionTarget);
    }
  };

  const startFix = async (): Promise<void> => {
    const actionTarget = targetKey;
    setError(null);
    setErrorTarget(null);
    setFixing(true);
    try {
      const { run } = await api.fixIssue(repo, number);
      if (currentTarget.current !== actionTarget) return;
      // Land on the animated PR-preview view, not the raw run transcript.
      location.hash = `#/runs/${run.id}/preview`;
    } catch (err) {
      if (currentTarget.current !== actionTarget) return;
      setError(String(err));
      setErrorTarget(actionTarget);
      setFixing(false);
    }
  };

  const setIssueState = async (next: 'open' | 'closed'): Promise<void> => {
    const actionTarget = targetKey;
    setBusy(true);
    setError(null);
    setErrorTarget(null);
    try {
      await api.setIssueState(repo, number, next);
      if (currentTarget.current !== actionTarget) return;
      await refresh();
    } catch (err) {
      if (currentTarget.current === actionTarget) {
        setError(String(err));
        setErrorTarget(actionTarget);
      }
    } finally {
      if (currentTarget.current === actionTarget) setBusy(false);
    }
  };

  const inCurrentTarget = dataTarget === targetKey;
  return {
    issue: inCurrentTarget ? issue : null,
    triage: inCurrentTarget ? triage : null,
    pipelineRuns: inCurrentTarget ? pipelineRuns : [],
    error: errorTarget === targetKey ? error : null,
    refresh,
    canAct,
    canReadRuns,
    canUseAgents,
    triaging: inCurrentTarget && triaging,
    startTriage,
    fixing: inCurrentTarget && fixing,
    startFix,
    busy: inCurrentTarget && busy,
    setIssueState,
  };
}
