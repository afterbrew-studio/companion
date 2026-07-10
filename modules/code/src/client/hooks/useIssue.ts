import { useCallback, useEffect, useState } from 'react';
import { onServerMessage } from '@companion/core/client';
import { useAuth } from '@companion/module-core/client';
import type { IssueRecord, TriageResult } from '../../contract/index.js';
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
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
  readonly canAct: boolean;
  readonly triaging: boolean;
  readonly startTriage: () => Promise<void>;
  readonly fixing: boolean;
  readonly startFix: () => Promise<void>;
  readonly busy: boolean;
  readonly setIssueState: (next: 'open' | 'closed') => Promise<void>;
}

export function useIssue(repo: string, number: number): UseIssue {
  const { can } = useAuth();
  const canAct = can('issues:act');
  const [issue, setIssue] = useState<IssueRecord | null>(null);
  const [triage, setTriage] = useState<TriageResult | null>(null);
  const [triaging, setTriaging] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const { issue, triage } = await api.getIssue(repo, number);
      setIssue(issue);
      setTriage(triage);
      if (triage && (triage.status === 'pending' || triage.status === 'applied')) setTriaging(false);
    } catch (err) {
      setError(String(err));
    }
  }, [repo, number]);

  useEffect(() => {
    void refresh();
    return onServerMessage((msg) => {
      if ((msg.t === 'triage.changed' || msg.t === 'issues.changed') && msg.repo === repo) void refresh();
    });
  }, [refresh, repo]);

  const startTriage = async (): Promise<void> => {
    setTriaging(true);
    setError(null);
    try {
      await api.triageIssue(repo, number);
    } catch (err) {
      setTriaging(false);
      setError(String(err));
    }
  };

  const startFix = async (): Promise<void> => {
    setError(null);
    setFixing(true);
    try {
      const { run } = await api.fixIssue(repo, number);
      // Land on the animated PR-preview view, not the raw run transcript.
      location.hash = `#/runs/${run.id}/preview`;
    } catch (err) {
      setError(String(err));
      setFixing(false);
    }
  };

  const setIssueState = async (next: 'open' | 'closed'): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.setIssueState(repo, number, next);
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return { issue, triage, error, refresh, canAct, triaging, startTriage, fixing, startFix, busy, setIssueState };
}
