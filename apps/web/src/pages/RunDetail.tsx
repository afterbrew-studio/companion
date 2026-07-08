import { useCallback, useEffect, useRef, useState } from 'react';
import type { AskRequest, ModelCatalog, RunRecord } from '@companion/contract';
import { api, onServerMessage } from '../lib/api.js';
import { emptyFold, foldEvent, foldMany, type FoldState } from '../transcript/fold.js';
import { Transcript } from '../transcript/Transcript.js';
import { AskSheet } from '../components/AskSheet.js';
import { Markdown } from '../components/Markdown.js';
import { DiffView } from '../components/DiffView.js';
import { ActionMenu } from '../components/ui.js';
import { statusBadge } from './RunsPage.js';

export function RunDetail({ runId }: { runId: string }): JSX.Element {
  const [run, setRun] = useState<RunRecord | null>(null);
  const [asks, setAsks] = useState<AskRequest[]>([]);
  const [fold, setFold] = useState<FoldState>(emptyFold);
  const [busy, setBusy] = useState(false);
  const [lifecycle, setLifecycle] = useState<'resuming' | 'stopping' | null>(null);
  const [activeTurn, setActiveTurn] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [runnerNames, setRunnerNames] = useState<ReadonlyMap<string, string> | null>(null);
  const foldRef = useRef(fold);
  foldRef.current = fold;

  // Resolve the runner id to its display name — fetched once, and only when
  // the run is pinned to an explicit runner. Viewers without runners:manage
  // fall back to showing the raw id.
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

  // Resume/Stop spawn or reap gateway processes — a resume can take a while
  // (moxxy serve + gateway boot), so the button must show progress and any
  // refusal (live-run cap, missing providers) must land in the error bar.
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
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col px-6">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-zinc-200 py-3 dark:border-zinc-800">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold">{run?.title ?? runId}</h2>
          {run ? (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className={statusBadge(run.status, run.live)}>{run.live ? 'live' : run.status}</span>
              <span className="dim" title="Token usage this run (prompt / completion)">
                {formatTokens(fold.inputTokens + run.inputTokens)} in ·{' '}
                {formatTokens(fold.outputTokens + run.outputTokens)} out
              </span>
              {run.runnerId ? (
                <span className="dim" title="Machine executing this run">
                  on {runnerNames?.get(run.runnerId) ?? run.runnerId}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        {run ? (
          <div className="flex shrink-0 items-center gap-2" role="toolbar" aria-label="Run actions">
            <ModelPicker run={run} onChanged={setRun} />
            {!run.live ? (
              <button className="btn-ghost" disabled={lifecycle !== null} onClick={() => void lifecycleAction('resume')}>
                {lifecycle === 'resuming' ? 'Resuming…' : 'Resume'}
              </button>
            ) : (
              <button className="btn-ghost" disabled={lifecycle !== null} onClick={() => void lifecycleAction('stop')}>
                {lifecycle === 'stopping' ? 'Stopping…' : 'Stop'}
              </button>
            )}
          </div>
        ) : null}
      </header>

      {run && (run.kind === 'fix' || run.kind === 'implement') && (run.status === 'review' || run.status === 'completed') ? (
        <ReviewPanel run={run} onChange={refresh} />
      ) : null}

      <Transcript blocks={fold.blocks} />

      {asks.map((ask) => (
        <AskSheet key={ask.requestId} ask={ask} onRespond={(r) => void respondAsk(ask.requestId, r)} />
      ))}

      {error ? <div className="error-bar">{error}</div> : null}

      <footer className="pt-3 pb-4">
        <div className="flex items-end gap-2 rounded-xl border border-zinc-300 p-2 focus-within:border-zinc-500 dark:border-zinc-700 dark:focus-within:border-zinc-400">
          <textarea
            className="max-h-40 min-h-11 flex-1 resize-none border-none bg-transparent px-1.5 py-1 text-[13px] outline-none placeholder:text-zinc-400"
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
            <button className="btn-danger-ghost" onClick={() => void api.abort(runId)} aria-label="Abort the running turn">
              Abort
            </button>
          ) : (
            <button
              className="dim flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors hover:bg-zinc-100 hover:text-zinc-800 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              disabled={!run?.live || busy || !draft.trim()}
              onClick={() => void send()}
              aria-label="Send prompt"
              title="Send (Enter)"
            >
              <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden>
                <path
                  d="M14 2 7.5 8.5M14 2 9.8 14a.4.4 0 0 1-.75.02L7.5 8.5 2 6.55a.4.4 0 0 1 .02-.76L14 2z"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
        </div>
        <p className="dim mt-1.5 px-1 text-[11px]">
          Enter to send · Shift+Enter for a new line{activeTurn ? ' · agent is working' : ''}
        </p>
      </footer>
    </div>
  );
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * On-the-fly model switch. The list comes from the run's live moxxy gateway
 * (connected providers + their models); switching persists on the run and is
 * pushed to the session so even goal-mode turns use it.
 */
function ModelPicker({ run, onChanged }: { run: RunRecord; onChanged: (run: RunRecord) => void }): JSX.Element {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!run.live) {
      setCatalog(null);
      return;
    }
    let alive = true;
    api
      .runModels(run.id)
      .then((c) => alive && setCatalog(c))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [run.id, run.live]);

  const current = run.model ?? '';

  if (!run.live || !catalog) {
    // Not live (or catalog unavailable): show the pinned model read-only.
    return run.model ? (
      <span className="badge normal-case" title="Model pinned for this run — resume to change">
        {run.model}
      </span>
    ) : (
      <span className="dim text-xs" title={error ? 'model list unavailable' : undefined}>
        {error ? 'models n/a' : ''}
      </span>
    );
  }

  const pick = async (value: string): Promise<void> => {
    setBusy(true);
    try {
      const provider =
        value === ''
          ? undefined
          : catalog.providers.find((p) => p.models.some((m) => m.id === value))?.name;
      const { run: next } = await api.setRunModel(run.id, value === '' ? null : value, provider);
      onChanged(next);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  const selectable = catalog.providers.filter((p) => p.enabled && p.models.length > 0);

  return (
    <select
      className="input max-w-48 py-1.5 text-xs"
      aria-label="Model for this run"
      title="Model for this run (from the moxxy gateway)"
      value={current}
      disabled={busy}
      onChange={(e) => void pick(e.target.value)}
    >
      <option value="">default — {catalog.defaultModel}</option>
      {selectable.map((p) => (
        <optgroup key={p.name} label={`${p.name}${p.ready ? '' : ' (no credentials)'}`}>
          {p.models.map((m) => (
            <option key={`${p.name}:${m.id}`} value={m.id} disabled={!p.ready}>
              {m.id}
              {m.contextWindow ? ` · ${Math.round(m.contextWindow / 1000)}k ctx` : ''}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
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
    // Reserve the tab in the gesture so it isn't popup-blocked after the await.
    const tab = window.open('', '_blank');
    setBusy(true);
    setError(null);
    try {
      const { prUrl } = await api.approvePr(run.id);
      if (tab) tab.location.href = prUrl;
      else window.open(prUrl, '_blank');
      await onChange();
    } catch (err) {
      tab?.close();
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
    <div className="my-3 rounded-xl border border-accent-500/60 p-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <strong className="text-sm">
          Review — agent finished on branch <code className="text-[12px]">{run.branch}</code>
        </strong>
        <span className="flex-1" />
        <button className="btn" disabled={busy || diff === null} onClick={() => void approve()}>
          {busy ? 'Working…' : 'Approve → push + open PR'}
        </button>
        <ActionMenu
          label="Review actions"
          actions={[
            { label: open ? 'Hide diff' : 'Show diff', onSelect: () => setOpen((v) => !v) },
            { label: 'Discard run…', onSelect: () => void discard(), danger: true, disabled: busy },
          ]}
        />
      </div>
      {run.outcome ? (
        <div className="mt-2">
          <Markdown text={run.outcome} />
        </div>
      ) : null}
      <p className="dim mt-2">
        Not convinced? Send a prompt below — the agent keeps working on the same branch.
      </p>
      {error ? <div className="error-bar">{error}</div> : null}
      {open ? (
        diff === null ? (
          <div className="dim mt-2">Loading diff…</div>
        ) : diff.trim() ? (
          <DiffView diff={diff} className="mt-2.5" />
        ) : (
          <div className="banner-warn">The agent produced no changes.</div>
        )
      ) : null}
    </div>
  );
}
