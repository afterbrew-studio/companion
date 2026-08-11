import { useEffect, useMemo, useRef, useState } from 'react';
import { useKernel } from '@moxxy/companion-sdk/client';
import { useAuth } from '@companion/module-core/client';
import { codeApi } from '@companion/module-code/client';
import type { RepoRecord } from '@companion/module-code/contract';
import { operateApi } from '@companion/module-operate/client';
import {
  EmptyState,
  ErrorBar,
  Page,
  PageHeader,
  RowsSkeleton,
  Spinner,
  useConfirm,
} from '@moxxy/companion-sdk/ui';
import type { PlaygroundEvaluationCaseRecord, PlaygroundEvaluationRun } from '../../contract/index.js';
import { playgroundApi } from '../api.js';
import { EvaluationCaseCard } from '../components/EvaluationCaseCard.js';
import { EvaluationCaseEditor } from '../components/EvaluationCaseEditor.js';
import { ProductionEvaluationSuite } from '../components/ProductionEvaluationSuite.js';
import { useEvaluationCases } from '../hooks/useEvaluationCases.js';

/** Saved, replayable prompt cases: the release gate missing from Agent Lab. */
export function EvaluationsPage(): React.JSX.Element {
  const kernel = useKernel();
  const { can } = useAuth();
  const { snapshot, production, loading, error: loadError, refresh } = useEvaluationCases();
  const [repos, setRepos] = useState<RepoRecord[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [editing, setEditing] = useState<PlaygroundEvaluationCaseRecord | 'new' | null>(null);
  const [runningIds, setRunningIds] = useState<ReadonlySet<string>>(new Set());
  const [suiteProgress, setSuiteProgress] = useState<{
    readonly done: number;
    readonly total: number;
    readonly current: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const stopSuite = useRef(false);
  const { confirmDanger, confirmElement } = useConfirm();
  const codeEnabled = kernel.descriptors.some((descriptor) => descriptor.id === 'code' && descriptor.enabled);
  const canRun = can('runs:read') && can('runs:act');

  useEffect(() => {
    if (codeEnabled && can('repos:read')) {
      void codeApi
        .listRepos()
        .then((response) => setRepos(response.repos))
        .catch((err) => {
          setRepos([]);
          setOptionsError(`Repository choices could not be loaded; scratch cases still work. ${errorText(err)}`);
        });
    }
    if (can('skills:manage')) {
      void operateApi
        .listSkills()
        .then((response) => setSkills(response.skills.map((skill) => skill.name)))
        .catch((err) => {
          setSkills([]);
          setOptionsError(`Skill choices could not be loaded; cases without a skill still work. ${errorText(err)}`);
        });
    }
  }, [can, codeEnabled]);

  const cases = snapshot?.cases ?? [];
  const latestByCase = useMemo(() => {
    const latest = new Map<string, PlaygroundEvaluationRun>();
    for (const run of snapshot?.runs ?? []) if (!latest.has(run.caseId)) latest.set(run.caseId, run);
    return latest;
  }, [snapshot]);
  const summary = useMemo(() => summarize(cases, latestByCase), [cases, latestByCase]);

  const runCase = async (record: PlaygroundEvaluationCaseRecord): Promise<void> => {
    setRunningIds((current) => new Set(current).add(record.id));
    setError(null);
    try {
      await playgroundApi.runEvaluationCase(record.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunningIds((current) => {
        const next = new Set(current);
        next.delete(record.id);
        return next;
      });
    }
  };

  const runSuite = async (): Promise<void> => {
    stopSuite.current = false;
    setError(null);
    setSuiteProgress({ done: 0, total: cases.length, current: cases[0]?.name ?? '' });
    let done = 0;
    for (const record of cases) {
      if (stopSuite.current) break;
      setSuiteProgress({ done, total: cases.length, current: record.name });
      setRunningIds(new Set([record.id]));
      try {
        await playgroundApi.runEvaluationCase(record.id);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        setError(`Suite continued after “${record.name}” failed to start: ${reason}`);
      }
      done += 1;
      setSuiteProgress({ done, total: cases.length, current: record.name });
      await refresh();
    }
    setRunningIds(new Set());
    setSuiteProgress(null);
  };

  const remove = async (record: PlaygroundEvaluationCaseRecord): Promise<void> => {
    const confirmed = await confirmDanger({
      title: `Delete “${record.name}”?`,
      message: 'The saved case and its comparison history will be removed. Agent transcripts remain under Agent Runs.',
    });
    if (!confirmed) return;
    setError(null);
    try {
      await playgroundApi.deleteEvaluationCase(record.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Page>
      <PageHeader
        title="Evaluations"
        subtitle="Prove production prompts and custom AI behavior before changing a model, prompt or rule"
        actions={<button className="btn" onClick={() => setEditing('new')}>New regression case</button>}
      />
      <ErrorBar error={error ?? loadError ?? optionsError} className="mb-3" />

      <ProductionEvaluationSuite
        snapshot={production}
        loading={loading}
        refresh={refresh}
        reportError={setError}
        canRun={canRun}
      />

      <div className="mb-3">
        <h2 className="text-base font-semibold">Custom regression lab</h2>
        <p className="dim mt-1 text-xs">
          Save repository-specific examples and deterministic assertions without changing the immutable release gate.
        </p>
      </div>

      <section className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4" aria-label="Evaluation health">
        <SummaryTile label="Saved cases" value={cases.length} hint="versioned inputs and expectations" />
        <SummaryTile label="Passing" value={summary.passed} hint="latest replay passed" tone="green" />
        <SummaryTile
          label="Needs attention"
          value={summary.failed}
          hint="failed, errored or not run"
          tone={summary.failed ? 'amber' : undefined}
        />
        <SummaryTile
          label="Rollout blockers"
          value={summary.blockers}
          hint="safety-critical latest failures"
          tone={summary.blockers ? 'red' : undefined}
        />
      </section>

      <section className="card mb-4 p-4" aria-label="How evaluation works">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
          <div>
            <h2 className="text-sm font-semibold">A model never grades itself</h2>
            <p className="dim mt-1 max-w-3xl text-xs leading-relaxed">
              Companion runs each case through the same read-only fence as Agent Lab, then deterministic checks
              verify required evidence, forbidden claims, JSON paths/values, latency and token ceilings. Repo cases
              are shared only with that workspace; scratch cases are private.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {suiteProgress ? (
              <>
                <span className="flex items-center gap-1.5 text-xs tabular-nums" role="status">
                  <Spinner /> {suiteProgress.done}/{suiteProgress.total} · {suiteProgress.current}
                </span>
                <button className="btn-ghost" onClick={() => { stopSuite.current = true; }}>
                  Stop after current
                </button>
              </>
            ) : (
              <button
                className="btn"
                disabled={!canRun || cases.length === 0 || runningIds.size > 0}
                title={canRun ? undefined : 'Requires runs:read and runs:act'}
                onClick={() => void runSuite()}
              >
                Run all sequentially
              </button>
            )}
          </div>
        </div>
        {suiteProgress ? (
          <div
            className="mt-3 h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={suiteProgress.total}
            aria-valuenow={suiteProgress.done}
          >
            <div
              className="h-full bg-[#2a78d6] transition-[width] duration-300 dark:bg-[#5aa2f0]"
              style={{ width: `${suiteProgress.total ? (suiteProgress.done / suiteProgress.total) * 100 : 0}%` }}
            />
          </div>
        ) : null}
      </section>

      {loading && snapshot === null ? <RowsSkeleton rows={5} /> : null}
      {!loading && cases.length === 0 ? (
        <EmptyState
          title="No regression cases yet"
          hint="Start with one known bad or prompt-injection example. State exactly what must be found and what must never be claimed."
          action={<button className="btn" onClick={() => setEditing('new')}>Create the first case</button>}
        />
      ) : null}
      {cases.length > 0 ? (
        <div className="flex flex-col gap-3">
          {cases.map((record) => (
            <EvaluationCaseCard
              key={record.id}
              record={record}
              latest={latestByCase.get(record.id) ?? null}
              running={runningIds.has(record.id)}
              disabled={!canRun || (runningIds.size > 0 && !runningIds.has(record.id))}
              onRun={() => void runCase(record)}
              onEdit={() => setEditing(record)}
              onDelete={() => void remove(record)}
            />
          ))}
        </div>
      ) : null}

      {editing ? (
        <EvaluationCaseEditor
          record={editing === 'new' ? null : editing}
          repos={repos}
          skills={skills}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      ) : null}
      {confirmElement}
    </Page>
  );
}

function SummaryTile({
  label,
  value,
  hint,
  tone,
}: {
  readonly label: string;
  readonly value: number;
  readonly hint: string;
  readonly tone?: 'green' | 'amber' | 'red';
}): React.JSX.Element {
  const colour = tone === 'green'
    ? 'text-emerald-600 dark:text-emerald-400'
    : tone === 'amber'
      ? 'text-amber-600 dark:text-amber-400'
      : tone === 'red'
        ? 'text-red-600 dark:text-red-400'
        : '';
  return (
    <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="dim text-[10px] font-medium tracking-widest uppercase">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${colour}`}>{value}</div>
      <div className="dim mt-0.5 text-[11px]">{hint}</div>
    </div>
  );
}

function summarize(
  cases: ReadonlyArray<PlaygroundEvaluationCaseRecord>,
  latest: ReadonlyMap<string, PlaygroundEvaluationRun>,
): { readonly passed: number; readonly failed: number; readonly blockers: number } {
  let passed = 0;
  let blockers = 0;
  for (const record of cases) {
    const run = latest.get(record.id);
    if (run?.status === 'passed') passed += 1;
    else if (record.safetyCritical) blockers += 1;
  }
  return { passed, failed: cases.length - passed, blockers };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
