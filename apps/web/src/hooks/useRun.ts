import { useCallback, useEffect, useRef, useState } from 'react';
import type { AskRequest, RunRecord } from '@companion/contract';
import { api, onServerMessage } from '../lib/api.js';
import { emptyFold, foldEvent, foldMany, type FoldState } from '../transcript/fold.js';

/**
 * One agent run's transcript and interaction layer: the record, pending asks,
 * the folded event stream (seeded from history, then live), the runner name,
 * and every action — resume/stop, prompt, answer an ask, abort a turn. The
 * detail page is presentation over this; only the composer draft stays local.
 */
export interface UseRun {
  readonly run: RunRecord | null;
  readonly setRun: (run: RunRecord) => void;
  readonly asks: AskRequest[];
  readonly fold: FoldState;
  readonly activeTurn: string | null;
  readonly error: string | null;
  readonly runnerNames: ReadonlyMap<string, string> | null;
  readonly lifecycle: 'resuming' | 'stopping' | null;
  readonly busy: boolean;
  readonly refresh: () => Promise<void>;
  readonly lifecycleAction: (action: 'resume' | 'stop') => Promise<void>;
  /** Sends a turn; resolves true on success so the caller can clear its draft. */
  readonly sendPrompt: (text: string) => Promise<boolean>;
  readonly respondAsk: (requestId: string, response: Record<string, unknown>) => Promise<void>;
  readonly abort: () => void;
}

export function useRun(runId: string): UseRun {
  const [run, setRun] = useState<RunRecord | null>(null);
  const [asks, setAsks] = useState<AskRequest[]>([]);
  const [fold, setFold] = useState<FoldState>(emptyFold);
  const [busy, setBusy] = useState(false);
  const [lifecycle, setLifecycle] = useState<'resuming' | 'stopping' | null>(null);
  const [activeTurn, setActiveTurn] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runnerNames, setRunnerNames] = useState<ReadonlyMap<string, string> | null>(null);
  const foldRef = useRef(fold);
  foldRef.current = fold;

  // Resolve the runner id to its display name — fetched once, only when the run
  // is pinned to an explicit runner.
  useEffect(() => {
    if (!run?.runnerId || runnerNames) return;
    let alive = true;
    api
      .listRunners()
      .then(({ runners }) => alive && setRunnerNames(new Map(runners.map((r) => [r.id, r.name]))))
      .catch(() => alive && setRunnerNames(new Map()));
    return () => {
      alive = false;
    };
  }, [run?.runnerId, runnerNames]);

  const refresh = useCallback(async () => {
    try {
      const { run, pendingAsks } = await api.getRun(runId);
      setRun(run);
      setAsks(pendingAsks);
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
      switch (msg.t) {
        case 'event':
          setFold({ ...foldEvent(foldRef.current, msg.event) });
          break;
        case 'turn':
          setActiveTurn(msg.phase === 'started' ? (msg.turnId ?? 'turn') : null);
          break;
        case 'ask':
          setAsks((prev) => (prev.some((a) => a.requestId === msg.ask.requestId) ? prev : [...prev, msg.ask]));
          break;
        case 'askResolved':
          setAsks((prev) => prev.filter((a) => a.requestId !== msg.requestId));
          break;
        case 'run.changed':
          setRun(msg.run);
          break;
        default:
          break;
      }
    });
  }, [runId]);

  const lifecycleAction = async (action: 'resume' | 'stop'): Promise<void> => {
    if (lifecycle) return;
    setLifecycle(action === 'resume' ? 'resuming' : 'stopping');
    setError(null);
    try {
      if (action === 'resume') await api.resumeRun(runId);
      else await api.stopRun(runId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLifecycle(null);
    }
  };

  const sendPrompt = async (text: string): Promise<boolean> => {
    const prompt = text.trim();
    if (!prompt || busy) return false;
    setBusy(true);
    setError(null);
    try {
      await api.prompt(runId, prompt);
      return true;
    } catch (err) {
      setError(String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const respondAsk = async (requestId: string, response: Record<string, unknown>): Promise<void> => {
    try {
      await api.respondAsk(runId, requestId, response);
      setAsks((prev) => prev.filter((a) => a.requestId !== requestId));
    } catch (err) {
      setError(String(err));
    }
  };

  const abort = (): void => void api.abort(runId);

  return {
    run,
    setRun,
    asks,
    fold,
    activeTurn,
    error,
    runnerNames,
    lifecycle,
    busy,
    refresh,
    lifecycleAction,
    sendPrompt,
    respondAsk,
    abort,
  };
}
