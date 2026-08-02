import { useEffect, useState } from 'react';
import { ActionMenu, DiffView, ErrorBar, IconButton, InlineLoading, Markdown, MetaSignal, formatTokens } from '@moxxy/companion-ui';
import type { ModelCatalog, RunRecord, RunVerification } from '../../contract/index.js';
import { operateApi as api } from '../api.js';
import { useRun } from '../hooks/useRun.js';
import { Transcript } from '../transcript/Transcript.js';
import { AskSheet } from '../components/AskSheet.js';
import { statusBadge } from './RunsPage.js';

export function RunDetail({ runId }: { runId: string }): JSX.Element {
  const { run, setRun, asks, fold, historyState, activeTurn, error, runnerNames, lifecycle, busy, refresh, lifecycleAction, sendPrompt, respondAsk, abort } =
    useRun(runId);
  const [draft, setDraft] = useState('');

  const send = async (): Promise<void> => {
    if (await sendPrompt(draft)) setDraft('');
  };

  // Prompting blind into a run whose transcript hasn't seeded yet (remote
  // runner mid-turn) is how prompts get double-sent — hold the composer shut.
  const composerLocked = !run?.live || busy || historyState !== 'ready';

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
              {/* A machine may have several runtimes installed and a run is
                  bound to the one it started under, so "which agent ran this"
                  is a fact about the run, not something to infer from the
                  machine's current setting. */}
              <span className="dim" title="Agent runtime this run started under">
                via {run.harness.label}
                {run.model ? ` · ${run.model}` : ''}
              </span>
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

      {historyState !== 'ready' && fold.blocks.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
          {historyState === 'loading' ? (
            <InlineLoading label="Loading the transcript…" />
          ) : (
            <>
              <span className="text-sm font-medium text-zinc-600 dark:text-zinc-300">
                The transcript didn&apos;t load
              </span>
              <span className="dim text-[13px]">The runner didn&apos;t answer in time — retrying automatically.</span>
              <button className="btn-ghost" onClick={() => void refresh()}>
                Retry now
              </button>
            </>
          )}
        </div>
      ) : (
        <Transcript blocks={fold.blocks} />
      )}

      {asks.map((ask) => (
        <AskSheet key={ask.requestId} ask={ask} onRespond={(r) => void respondAsk(ask.requestId, r)} />
      ))}

      {/* An approval sheet on a policy harness would wait for a prompt that is
          never coming, so this says what settled the permission instead. */}
      {run?.live && run.harness.capabilities.approvals === 'policy' ? (
        <p className="dim my-2 text-[11px]" role="status">
          {run.harness.label} settles tool permission before a turn starts, so nothing is held for approval here.
        </p>
      ) : null}

      <ErrorBar error={error} />

      <footer className="pt-3 pb-4">
        <div className="flex items-end gap-2 rounded-xl border border-zinc-300 p-2 focus-within:border-zinc-500 dark:border-zinc-700 dark:focus-within:border-zinc-400">
          <textarea
            className="max-h-40 min-h-11 flex-1 resize-none border-none bg-transparent px-1.5 py-1 text-[13px] outline-none placeholder:text-zinc-400"
            value={draft}
            placeholder={
              !run?.live
                ? 'Run is not live — resume it to chat'
                : historyState === 'loading'
                  ? 'Loading the transcript…'
                  : historyState === 'error'
                    ? 'Waiting for the runner — transcript not loaded yet'
                    : 'Send a prompt…'
            }
            disabled={composerLocked}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          {activeTurn ? (
            <button className="btn-danger-ghost" onClick={abort} aria-label="Abort the running turn">
              Abort
            </button>
          ) : (
            <IconButton label="Send prompt" disabled={composerLocked || !draft.trim()} onClick={() => void send()}>
              <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden>
                <path
                  d="M14 2 7.5 8.5M14 2 9.8 14a.4.4 0 0 1-.75.02L7.5 8.5 2 6.55a.4.4 0 0 1 .02-.76L14 2z"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </IconButton>
          )}
        </div>
        <p className="dim mt-1.5 px-1 text-[11px]">
          Enter to send · Shift+Enter for a new line{activeTurn ? ' · agent is working' : ''}
        </p>
      </footer>
    </div>
  );
}

/**
 * On-the-fly model switch. The list comes from the run's live gateway
 * (connected providers + their models); switching persists on the run and is
 * pushed to the session so even goal-mode turns use it.
 *
 * A harness that brings its own models has no provider catalog to read, so the
 * picker degrades to the read-only badge rather than offering a list nothing
 * would fill.
 */
function ModelPicker({ run, onChanged }: { run: RunRecord; onChanged: (run: RunRecord) => void }): JSX.Element {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const fromProviders = run.harness.capabilities.models === 'providers';

  useEffect(() => {
    if (!run.live || !fromProviders) {
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
  }, [run.id, run.live, fromProviders]);

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
      className="input max-w-48"
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
    <div className="card my-3 border-accent-500/60">
      {/* Above the diff, deliberately: the point of verifying is that a reviewer
          learns the thing does not build before spending attention on reading it. */}
      <VerificationLine verification={run.verification} />
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
      <ErrorBar error={error} />
      {open ? (
        diff === null ? (
          <InlineLoading label="Loading diff…" className="mt-2" />
        ) : diff.trim() ? (
          <DiffView diff={diff} className="mt-2.5" />
        ) : (
          <div className="banner-warn">The agent produced no changes.</div>
        )
      ) : null}
    </div>
  );
}

/**
 * What the repository's own verification command found in this worktree.
 *
 * Renders nothing when there is nothing to say, and never renders "not checked"
 * as anything resembling a pass: a missing command is a configuration gap, and
 * dressing it up as a green tick would make the whole feature a lie.
 */
function VerificationLine({ verification }: { verification: RunVerification | null }): JSX.Element | null {
  if (verification === null) return null;
  if (verification.status === 'running') {
    return <InlineLoading label={`Verifying: ${verification.command}`} className="mb-2.5" />;
  }
  if (verification.status === 'unavailable') {
    return (
      <p className="dim mb-2.5 text-xs">
        Not verified.{' '}
        {verification.output ||
          'Set a verification command on this repository and a failing build will be caught before you read the diff.'}
      </p>
    );
  }
  const passed = verification.status === 'passed';
  return (
    <div className={passed ? 'banner-info mb-2.5 text-xs' : 'error-bar mb-2.5 text-xs'} role="status">
      <div className="flex flex-wrap items-baseline gap-2">
        <MetaSignal tone={passed ? 'green' : 'red'} label={passed ? 'verification passed' : 'verification failed'} />
        <code className="text-[11px]">{verification.command}</code>
        <span className="dim">
          {verification.timedOut ? 'timed out' : `exit ${verification.exitCode ?? 'signal'}`} ·{' '}
          {Math.round(verification.durationMs / 1000)}s
        </span>
      </div>
      {!passed && verification.output ? (
        <pre className="mt-1.5 max-h-64 overflow-auto text-[11px] whitespace-pre-wrap">{verification.output}</pre>
      ) : null}
    </div>
  );
}
