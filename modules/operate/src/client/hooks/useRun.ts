import { useCallback, useEffect, useRef, useState } from 'react';
import type { AskRequest, MoxxyEvent } from '@companion/types';
import { onServerMessage } from '@companion/core/client';
import type { RunRecord } from '../../contract/index.js';
import { operateApi as api } from '../api.js';
import { emptyFold, foldEvent, foldMany, type FoldState } from '../transcript/fold.js';

/** The transcript seed: history not yet loaded / loaded / failed (auto-retrying). */
export type HistoryState = 'loading' | 'ready' | 'error';

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
  readonly historyState: HistoryState;
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
  const [historyState, setHistoryState] = useState<HistoryState>('loading');
  // Non-null while a seed is in flight: live WS events are diverted here and
  // replayed onto the seeded fold, instead of being clobbered by its reset.
  const seedBuffer = useRef<MoxxyEvent[] | null>(null);
  const seeded = useRef(false);
  const alive = useRef(true);
  const retryAttempt = useRef(0);
  const retryTimer = useRef<number | undefined>(undefined);
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
    window.clearTimeout(retryTimer.current);
    seedBuffer.current = [];
    if (!seeded.current) setHistoryState('loading');
    try {
      const { run, pendingAsks } = await api.getRun(runId);
      setRun(run);
      setAsks(pendingAsks);
      const segment = await api.history(runId, null, 300);
      const next = foldMany(emptyFold(), segment.events);
      for (const event of seedBuffer.current ?? []) foldEvent(next, event);
      setFold({ ...next });
      seeded.current = true;
      retryAttempt.current = 0;
      setError(null);
      setHistoryState('ready');
    } catch (err) {
      setError(String(err));
      // A remote runner mid-turn can transiently stall the history read —
      // retry on a capped backoff until the first seed lands.
      if (!seeded.current && alive.current) {
        setHistoryState('error');
        const attempt = ++retryAttempt.current;
        retryTimer.current = window.setTimeout(() => void refresh(), Math.min(3_000 * attempt, 15_000));
      }
    } finally {
      seedBuffer.current = null;
    }
  }, [runId]);

  useEffect(() => {
    alive.current = true;
    seeded.current = false;
    retryAttempt.current = 0;
    setFold(emptyFold());
    setHistoryState('loading');
    void refresh();
    return () => {
      alive.current = false;
      window.clearTimeout(retryTimer.current);
    };
  }, [refresh]);

  useEffect(() => {
    return onServerMessage((msg) => {
      if ('runId' in msg && msg.runId !== runId) return;
      switch (msg.t) {
        case 'event':
          if (seedBuffer.current) seedBuffer.current.push(msg.event);
          else setFold({ ...foldEvent(foldRef.current, msg.event) });
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
    historyState,
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
