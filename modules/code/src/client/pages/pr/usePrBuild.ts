import { useCallback, useEffect, useRef, useState } from 'react';
import { onServerMessage } from '@companion/core/client';
import { emptyFold, foldEvent, foldMany, operateApi as api, type Block, type FoldState } from '@companion/module-operate/client';
import type { RunRecord } from '@companion/module-operate/contract';

/**
 * A pull request taking shape from an agent run. Same idea as {@link usePr},
 * but the source is a run + its transcript rather than a PR record — this backs
 * the building view, where the PR doesn't exist yet.
 */
export type BuildPhase = 'loading' | 'building' | 'ready' | 'shipped' | 'failed';

export interface UsePrBuild {
  readonly run: RunRecord | null;
  readonly blocks: Block[];
  readonly phase: BuildPhase;
  readonly error: string | null;
  readonly busy: 'create' | 'discard' | 'refine' | null;
  readonly refresh: () => Promise<void>;
  /** Opens the PR on GitHub; resolves to its URL (or null on failure). */
  readonly createPr: () => Promise<string | null>;
  readonly discard: () => Promise<void>;
  readonly refine: (text: string) => Promise<void>;
}

export function usePrBuild(runId: string): UsePrBuild {
  const [run, setRun] = useState<RunRecord | null>(null);
  const [fold, setFold] = useState<FoldState>(emptyFold);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'create' | 'discard' | 'refine' | null>(null);
  const foldRef = useRef(fold);
  foldRef.current = fold;

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const { run } = await api.getRun(runId);
      setRun(run);
      const segment = await api.history(runId, null, 300);
      setFold({ ...foldMany(emptyFold(), segment.events) });
    } catch (err) {
      setError(String(err));
    }
  }, [runId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    return onServerMessage((msg) => {
      if ('runId' in msg && msg.runId !== runId) return;
      if (msg.t === 'event') setFold({ ...foldEvent(foldRef.current, msg.event) });
      else if (msg.t === 'run.changed') setRun(msg.run);
    });
  }, [runId]);

  const phase: BuildPhase = !run
    ? 'loading'
    : run.status === 'completed'
      ? 'shipped'
      : run.status === 'review'
        ? 'ready'
        : run.status === 'running' || run.status === 'provisioning' || run.status === 'queued'
          ? 'building'
          : // failed / interrupted / stopped / abandoned — ended without a PR.
            'failed';

  const createPr = useCallback(async (): Promise<string | null> => {
    setBusy('create');
    setError(null);
    try {
      const { prUrl } = await api.approvePr(runId);
      await refresh();
      return prUrl;
    } catch (err) {
      setError(String(err));
      return null;
    } finally {
      setBusy(null);
    }
  }, [runId, refresh]);

  const discard = useCallback(async (): Promise<void> => {
    setBusy('discard');
    setError(null);
    try {
      await api.discardRun(runId);
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  }, [runId, refresh]);

  const refine = useCallback(
    async (text: string): Promise<void> => {
      const t = text.trim();
      if (!t) return;
      setBusy('refine');
      setError(null);
      try {
        await api.prompt(runId, t);
        await refresh();
      } catch (err) {
        setError(String(err));
      } finally {
        setBusy(null);
      }
    },
    [runId, refresh],
  );

  return { run, blocks: fold.blocks, phase, error, busy, refresh, createPr, discard, refine };
}
