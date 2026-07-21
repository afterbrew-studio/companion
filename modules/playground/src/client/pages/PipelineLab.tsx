import { useEffect, useMemo, useState } from 'react';
import { useKernel } from '@companion/core/client';
import { codeApi } from '@companion/module-code/client';
import type { PipelineRecord, PipelineStepSpec, PrRecord, RepoRecord } from '@companion/module-code/contract';
import { Dropdown, EmptyState, ErrorBar, Field, Page, PageHeader, Spinner } from '@companion/ui';
import type { PipelinePreview } from '../../contract/index.js';
import { playgroundApi } from '../api.js';

/**
 * Pipeline evaluation bench (first cut): pick a pr-type pipeline and a PR and
 * see exactly which steps the engine would attempt, with their resolved config
 * snapshots — library refs resolved, overrides applied, unresolvable refs
 * flagged. Nothing executes; true step dry-run execution is deferred (see the
 * module's DESIGN.md).
 */
export function PipelineLabPage(): JSX.Element {
  const kernel = useKernel();
  const codeEnabled = kernel.descriptors.some((d) => d.id === 'code' && d.enabled);

  const [repos, setRepos] = useState<RepoRecord[] | null>(null);
  const [repo, setRepo] = useState('');
  const [pipelines, setPipelines] = useState<PipelineRecord[]>([]);
  const [pipelineId, setPipelineId] = useState('');
  const [prs, setPrs] = useState<PrRecord[]>([]);
  const [prNumber, setPrNumber] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PipelinePreview | null>(null);

  useEffect(() => {
    if (!codeEnabled) return;
    void codeApi
      .listRepos()
      .then((r) => {
        setRepos(r.repos);
        setRepo((prev) => prev || (r.repos[0]?.fullName ?? ''));
      })
      .catch((err) => setError(String(err)));
  }, [codeEnabled]);

  const workspaceId = useMemo(() => (repos ?? []).find((r) => r.fullName === repo)?.workspaceId ?? '', [repos, repo]);

  // Repo drives both follow-up feeds; stale selections reset with it.
  useEffect(() => {
    setPreview(null);
    setPipelineId('');
    setPrNumber(0);
    if (!repo || !workspaceId) return;
    void codeApi
      .workspacePipelines(workspaceId)
      .then((r) => {
        const prOnly = r.pipelines.filter((p) => p.type === 'pr');
        setPipelines(prOnly);
        setPipelineId((prev) => prev || (prOnly[0]?.id ?? ''));
      })
      .catch((err) => setError(String(err)));
    void codeApi
      .listPrs(repo)
      .then((r) => {
        const open = r.prs.filter((p) => p.state === 'open');
        setPrs(open);
        setPrNumber((prev) => prev || (open[0]?.number ?? 0));
      })
      .catch((err) => setError(String(err)));
  }, [repo, workspaceId]);

  const selected = useMemo(() => pipelines.find((p) => p.id === pipelineId), [pipelines, pipelineId]);

  if (!codeEnabled) {
    return (
      <Page>
        <PageHeader title="Pipeline Lab" subtitle="Preview what a pipeline would do — without running it" />
        <EmptyState title="The code module is disabled" hint="Pipelines live there — enable it to preview them." />
      </Page>
    );
  }

  const evaluate = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      setPreview(await playgroundApi.pipelinePreview(repo, pipelineId, prNumber));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page>
      <PageHeader title="Pipeline Lab" subtitle="Preview what a pipeline would do — without running it" />
      <ErrorBar error={error} className="mb-3" />

      {repos !== null && repos.length === 0 ? (
        <EmptyState title="No repositories connected" hint="Connect a repository first — pipelines run against its pull requests." />
      ) : (
        <div className="flex flex-col gap-4">
          <section aria-label="Evaluate" className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
            <h2 className="mb-3 text-xs font-semibold tracking-wide uppercase">Evaluate</h2>
            <div className="flex flex-col gap-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Repository">
                  <Dropdown
                    ariaLabel="Repository"
                    value={repo || null}
                    onChange={(v) => setRepo(v)}
                    options={(repos ?? []).map((r) => ({ value: r.fullName, label: r.fullName }))}
                  />
                </Field>
                <Field label="PR pipeline">
                  {pipelines.length > 0 ? (
                    <Dropdown
                      ariaLabel="PR pipeline"
                      value={pipelineId || null}
                      onChange={(v) => setPipelineId(v)}
                      options={pipelines.map((p) => ({ value: p.id, label: p.name }))}
                    />
                  ) : (
                    <p className="dim pt-1.5 text-sm">
                      None yet —{' '}
                      <a className="font-medium hover:underline" href="#/pipelines">
                        create one →
                      </a>
                    </p>
                  )}
                </Field>
                <Field label="Pull request">
                  {prs.length > 0 ? (
                    <Dropdown
                      ariaLabel="Pull request"
                      value={prNumber ? String(prNumber) : null}
                      onChange={(v) => setPrNumber(Number(v))}
                      options={prs.map((p) => ({ value: String(p.number), label: `#${p.number} — ${p.title.slice(0, 44)}` }))}
                    />
                  ) : (
                    <p className="dim pt-1.5 text-sm">No open PRs in this repo.</p>
                  )}
                </Field>
              </div>

              {selected ? (
                <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className="dim">Steps:</span>
                  {selected.steps.map((s, i) => (
                    <span key={i} className="flex items-center gap-1.5">
                      {i > 0 ? (
                        <span className="dim" aria-hidden>
                          →
                        </span>
                      ) : null}
                      <span className="chip">{stepChipLabel(s)}</span>
                    </span>
                  ))}
                  {selected.steps.length === 0 ? <span className="dim">no steps yet</span> : null}
                  {selected.description ? <span className="dim ml-2 truncate">{selected.description}</span> : null}
                </div>
              ) : null}

              <div className="flex flex-wrap items-center gap-3">
                <button className="btn" disabled={busy || !pipelineId || !prNumber} onClick={() => void evaluate()}>
                  {busy ? <Spinner /> : '✦ Evaluate'}
                </button>
                <span className="dim text-xs">Evaluation only — no step executes, nothing is posted.</span>
              </div>
            </div>
          </section>

          {preview ? (
            <PreviewTimeline preview={preview} />
          ) : (
            <EmptyState
              title="Nothing evaluated yet"
              hint="Pick a pipeline and a pull request, then Evaluate to see which steps would run — with their resolved configs."
            />
          )}
        </div>
      )}
    </Page>
  );
}

function stepChipLabel(spec: PipelineStepSpec): string {
  return spec.type === 'inline' ? spec.step.kind : (spec.overrides?.name ?? 'library step');
}

/** The evaluation result as a step timeline: what would run, in order, and why not. */
function PreviewTimeline({ preview }: { preview: PipelinePreview }): JSX.Element {
  const running = preview.steps.filter((s) => s.willRun).length;
  return (
    <section aria-label="Evaluation result" className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 className="text-xs font-semibold tracking-wide uppercase">Result</h2>
        <span className="text-sm font-medium">{preview.pipeline.name}</span>
        <span className="dim text-xs">
          → PR #{preview.target.prNumber} “{preview.target.title}” by {preview.target.author}
        </span>
        <span className="dim ml-auto text-xs tabular-nums">
          {running}/{preview.steps.length} step{preview.steps.length === 1 ? '' : 's'} would run
        </span>
      </div>
      <ol className="relative ml-3 flex flex-col gap-3 border-l-2 border-zinc-200 pl-5 dark:border-zinc-800">
        {preview.steps.map((s, i) => {
          const tone = s.willRun
            ? 'border-emerald-500 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
            : s.kind === 'unknown'
              ? 'border-red-500 bg-red-500/10 text-red-600 dark:text-red-400'
              : 'border-zinc-300 bg-zinc-500/10 text-zinc-500 dark:border-zinc-600';
          return (
            <li key={i} className={s.willRun ? '' : 'opacity-70'}>
              {/* Number bubble sits on the timeline rail. */}
              <span
                className={`absolute -left-[13px] flex size-6 items-center justify-center rounded-full border-2 bg-white text-[11px] font-semibold tabular-nums dark:bg-zinc-900 ${tone}`}
                aria-hidden
              >
                {i + 1}
              </span>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{s.name}</span>
                <span className="chip">{s.kind}</span>
                <span className="dim text-xs">{s.source === 'ref' ? 'library step' : 'inline'}</span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                    s.willRun
                      ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                      : s.kind === 'unknown'
                        ? 'bg-red-500/10 text-red-600 dark:text-red-400'
                        : 'bg-zinc-500/10 text-zinc-500'
                  }`}
                >
                  {s.willRun ? 'would run' : s.kind === 'unknown' ? 'unresolved' : 'skipped'}
                </span>
                {s.onFailure ? (
                  <span className="dim ml-auto text-xs">
                    on failure: <span className="font-medium">{s.onFailure}</span>
                  </span>
                ) : null}
              </div>
              {s.note ? <p className="mt-1 text-xs text-red-600 dark:text-red-400">{s.note}</p> : null}
              {s.config ? (
                <details className="mt-1.5">
                  <summary className="dim cursor-pointer text-xs hover:underline">Config snapshot</summary>
                  <pre className="code-inline mt-1 max-h-40 overflow-auto text-[11px] leading-relaxed whitespace-pre-wrap">
                    {JSON.stringify(s.config, null, 2)}
                  </pre>
                </details>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
