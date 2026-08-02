import { useCallback, useEffect, useRef, useState } from 'react';
import { onServerMessage, useLive } from '@moxxy/companion-sdk/client';
import {
  emptyFold,
  foldEvent,
  foldMany,
  operateApi,
  type Block,
  type FoldState,
} from '@companion/module-operate/client';
import type { RunListRecord } from '@companion/module-operate/contract';
import type { ReportRecord } from '@companion/module-workspace/contract';
import { workspaceApi } from '@companion/module-workspace/client';

export type DigestLivePhase = 'starting' | 'working' | 'failed' | 'done';
/** List seed plus the outcome carried by a subsequent full run.changed event. */
export type DigestRun = RunListRecord & { readonly outcome?: string | null };

export interface UseDigestLive {
  readonly run: DigestRun | null;
  readonly blocks: Block[];
  readonly phase: DigestLivePhase;
  /** The digest that landed while this page was watching, once it exists. */
  readonly report: ReportRecord | null;
}

/**
 * A digest taking shape for one repo. There is no run id up front — digest-now
 * returns before the queue even creates the run — so this watches the runs feed
 * for the repo's live report run, seeds its transcript from history, folds live
 * events, and declares done the moment a digest newer than the one present at
 * mount lands in reports (the fact-sheet fallback lands too, so a failed agent
 * still finishes the page). Operate reads are best-effort: a viewer without
 * runs:read keeps the staged loader, just without the live activity.
 */
export function useDigestLive(repo: string): UseDigestLive {
  const [run, setRun] = useState<DigestRun | null>(null);
  const [fold, setFold] = useState<FoldState>(emptyFold);
  const [report, setReport] = useState<ReportRecord | null>(null);
  const foldRef = useRef(fold);
  foldRef.current = fold;
  const runIdRef = useRef<string | null>(null);
  const seededRef = useRef(false);
  // Latest digest id at mount (null = none yet); a different id means ours landed.
  const baselineRef = useRef<string | null | undefined>(undefined);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const { reports } = await workspaceApi.listReports();
      const latest = reports.find((r) => r.kind === 'digest' && r.repo === repo) ?? null;
      if (baselineRef.current === undefined) baselineRef.current = latest?.id ?? null;
      else if (latest && latest.id !== baselineRef.current) setReport(latest);
    } catch {
      // reports:read gates this page, so this only delays "done" transiently.
    }
    try {
      const { runs } = await operateApi.listRunsPage({ repo, status: 'active', limit: 100 });
      // Adopt only a LIVE report run — the newest reaped one is yesterday's.
      // Once adopted, follow it by id so terminal status updates still arrive.
      const mine = runIdRef.current
        ? (runs.find((r) => r.id === runIdRef.current) ?? null)
        : (runs.find((r) => r.live && r.kind === 'report' && r.repo === repo) ?? null);
      if (!mine) return;
      runIdRef.current = mine.id;
      setRun(mine);
      if (!seededRef.current) {
        seededRef.current = true;
        const segment = await operateApi.history(mine.id, null, 300);
        setFold({ ...foldMany(emptyFold(), segment.events) });
      }
    } catch {
      // No runs:read (or the run is gone) — keep the loader indeterminate.
    }
  }, [repo]);

  useLive(refresh, (msg) => msg.t === 'runs.changed' || msg.t === 'reports.changed');

  useEffect(() => {
    return onServerMessage((msg) => {
      if (msg.t === 'event' && msg.runId === runIdRef.current) {
        setFold({ ...foldEvent(foldRef.current, msg.event) });
      } else if (msg.t === 'run.changed' && msg.run.id === runIdRef.current) {
        setRun(msg.run);
      }
    });
  }, []);

  const ended =
    run !== null &&
    (run.status === 'failed' || run.status === 'stopped' || run.status === 'interrupted' || run.status === 'abandoned');
  const phase: DigestLivePhase = report
    ? 'done'
    : ended
      ? 'failed'
      : run && run.status !== 'queued' && run.status !== 'provisioning'
        ? 'working' // 'completed' counts too: the report insert is moments away
        : 'starting';

  return { run, blocks: fold.blocks, phase, report };
}
