import { useCallback, useEffect, useRef, useState } from 'react';
import type { AskRequest, RunRecord } from '@companion/contract';
import { api, onServerMessage } from '../lib/api.js';
import { emptyFold, foldEvent, foldMany, type FoldState } from '../transcript/fold.js';
import { Transcript } from '../transcript/Transcript.js';
import { AskSheet } from '../components/AskSheet.js';
import { statusBadge } from './RunsPage.js';

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
    <div className="mx-auto flex h-full max-w-4xl flex-col px-6">
      <header className="flex items-center gap-3.5 border-b border-zinc-200 py-3.5 dark:border-zinc-800">
        <a className="linkish text-sm" href="#/runs">
          ← Runs
        </a>
        <h2 className="flex-1 truncate text-base font-semibold">{run?.title ?? runId}</h2>
        <div className="flex items-center gap-2.5">
          {run ? (
            <>
              <span className={statusBadge(run.status, run.live)}>{run.live ? 'live' : run.status}</span>
              <span className="dim">
                {formatTokens(fold.inputTokens + run.inputTokens)} in /{' '}
                {formatTokens(fold.outputTokens + run.outputTokens)} out
              </span>
              {!run.live ? (
                <button className="btn-ghost" onClick={() => void api.resumeRun(runId).then(refresh)}>
                  Resume
                </button>
              ) : (
                <button className="btn-ghost" onClick={() => void api.stopRun(runId).then(refresh)}>
                  Stop
                </button>
              )}
            </>
          ) : null}
        </div>
      </header>

      {run && (run.kind === 'fix' || run.kind === 'implement') && (run.status === 'review' || run.status === 'completed') ? (
        <ReviewPanel run={run} onChange={refresh} />
      ) : null}

      <Transcript blocks={fold.blocks} />

      {asks.map((ask) => (
        <AskSheet key={ask.requestId} ask={ask} onRespond={(r) => void respondAsk(ask.requestId, r)} />
      ))}

      {error ? <div className="error-bar">{error}</div> : null}

      <footer className="flex gap-2.5 border-t border-zinc-200 pt-3 pb-4 dark:border-zinc-800">
        <textarea
          className="input max-h-40 min-h-11 flex-1 resize-none"
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
          <button className="btn-danger" onClick={() => void api.abort(runId)}>
            Abort
          </button>
        ) : (
          <button className="btn" disabled={!run?.live || busy || !draft.trim()} onClick={() => void send()}>
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

function ReviewPanel({ run, onChange }: { run: RunRecord; onChange: () => Promise<void> }): JSX.Element {
  const [diff, setDiff] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (run.status !== 'review') return;
    void api
      .runDiff(run.id)
      .then((r) => setDiff(r.diff))
      .catch((err) => setError(String(err)));
  }, [run.id, run.status]);

  if (run.status === 'completed') {
    return run.prUrl ? (
      <div className="banner-info">
        Shipped:{' '}
        <a className="linkish" href={run.prUrl} target="_blank" rel="noreferrer">
          {run.prUrl}
        </a>
      </div>
    ) : (
      <div className="banner-info">Run completed.</div>
    );
  }

  const approve = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const { prUrl } = await api.approvePr(run.id);
      await onChange();
      window.open(prUrl, '_blank');
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const discard = async (): Promise<void> => {
    if (!confirm('Discard this run and its worktree? The branch is lost.')) return;
    setBusy(true);
    try {
      await api.discardRun(run.id);
      await onChange();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="my-3 rounded-xl border border-indigo-500/60 p-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <strong className="text-sm">Review — agent finished on branch {run.branch}</strong>
        <span className="dim">{run.outcome ?? ''}</span>
        <span className="flex-1" />
        <button className="linkish text-sm" onClick={() => setOpen((v) => !v)}>
          {open ? 'hide diff' : 'show diff'}
        </button>
        <button className="btn" disabled={busy || diff === null} onClick={() => void approve()}>
          {busy ? 'Working…' : 'Approve → push + open PR'}
        </button>
        <button className="btn-danger" disabled={busy} onClick={() => void discard()}>
          Discard
        </button>
      </div>
      {error ? <div className="error-bar">{error}</div> : null}
      {open ? (
        diff === null ? (
          <div className="dim mt-2">Loading diff…</div>
        ) : diff.trim() ? (
          <pre className="mono-pane mt-2.5 max-h-[420px]">{renderableDiff(diff)}</pre>
        ) : (
          <div className="banner-warn">The agent produced no changes.</div>
        )
      ) : null}
    </div>
  );
}

function renderableDiff(diff: string): string {
  return diff.length > 100_000 ? `${diff.slice(0, 100_000)}\n… (${diff.length - 100_000} more bytes)` : diff;
}
