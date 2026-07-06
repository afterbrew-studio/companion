import { useCallback, useEffect, useRef, useState } from 'react';
import type { AskRequest, RunRecord } from '@companion/contract';
import { api, onServerMessage } from '../lib/api.js';
import { emptyFold, foldEvent, foldMany, type FoldState } from '../transcript/fold.js';
import { Transcript } from '../transcript/Transcript.js';
import { AskSheet } from '../components/AskSheet.js';

export function RunDetail({ runId }: { runId: string }): JSX.Element {
  const [run, setRun] = useState<RunRecord | null>(null);
  const [asks, setAsks] = useState<AskRequest[]>([]);
  const [fold, setFold] = useState<FoldState>(emptyFold);
  const [busy, setBusy] = useState(false);
  const [activeTurn, setActiveTurn] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const foldRef = useRef(fold);
  foldRef.current = fold;

  const refresh = useCallback(async () => {
    try {
      const { run, pendingAsks } = await api.getRun(runId);
      setRun(run);
      setAsks(pendingAsks);
      const segment = await api.history(runId, null, 300);
      const next = foldMany(emptyFold(), segment.events);
      setFold({ ...next });
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
        case 'event': {
          const next = foldEvent(foldRef.current, msg.event);
          setFold({ ...next });
          break;
        }
        case 'turn':
          setActiveTurn(msg.phase === 'started' ? (msg.turnId ?? 'turn') : null);
          break;
        case 'ask':
          setAsks((prev) =>
            prev.some((a) => a.requestId === msg.ask.requestId) ? prev : [...prev, msg.ask],
          );
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

  const send = async (): Promise<void> => {
    const prompt = draft.trim();
    if (!prompt || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.prompt(runId, prompt);
      setDraft('');
    } catch (err) {
      setError(String(err));
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

  return (
    <div className="run-detail">
      <header className="run-header">
        <a href="#/runs">← Runs</a>
        <h2>{run?.title ?? runId}</h2>
        <div className="run-meta">
          {run ? (
            <>
              <span className={`badge status-${run.status}`}>{run.live ? 'live' : run.status}</span>
              <span className="usage">
                {formatTokens(fold.inputTokens + run.inputTokens)} in /{' '}
                {formatTokens(fold.outputTokens + run.outputTokens)} out
              </span>
              {!run.live ? (
                <button onClick={() => void api.resumeRun(runId).then(refresh)}>Resume</button>
              ) : (
                <button onClick={() => void api.stopRun(runId).then(refresh)}>Stop</button>
              )}
            </>
          ) : null}
        </div>
      </header>

      <Transcript blocks={fold.blocks} />

      {asks.map((ask) => (
        <AskSheet key={ask.requestId} ask={ask} onRespond={(r) => void respondAsk(ask.requestId, r)} />
      ))}

      {error ? <div className="error-bar">{error}</div> : null}

      <footer className="composer">
        <textarea
          value={draft}
          placeholder={run?.live ? 'Send a prompt…' : 'Run is not live — resume it to chat'}
          disabled={!run?.live || busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {activeTurn ? (
          <button className="danger" onClick={() => void api.abort(runId)}>
            Abort
          </button>
        ) : (
          <button disabled={!run?.live || busy || !draft.trim()} onClick={() => void send()}>
            Send
          </button>
        )}
      </footer>
    </div>
  );
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
