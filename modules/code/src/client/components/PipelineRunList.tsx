import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@companion/module-core/client';
import { ChevronDown, ErrorBar, ListCard, Spinner, timeAgo } from '@moxxy/companion-sdk/ui';
import type { PipelineRunRecord } from '../../contract/index.js';
import { codeApi as api } from '../api.js';
import { pipelineStatusBadge } from '../widgets.js';
import { StepRail } from './StepRail.js';

function targetLabel(run: PipelineRunRecord): string {
  if (run.target === 'platform') return run.repo;
  return `${run.repo} · ${run.target === 'issue' ? 'issue' : 'PR'} #${run.prNumber}`;
}

/** Keep the list light; one separately cached detail owns the heavy evidence. */
function summarizeRun(run: PipelineRunRecord): PipelineRunRecord {
  return {
    ...run,
    steps: run.steps.map(({ log: _log, detail: _detail, ...step }) => ({ ...step, detail: null })),
  };
}

/** Shared, controllable run history for PR, issue and workspace pipeline views. */
export function PipelineRunList({
  runs,
  title = 'Pipelines',
  showTarget = false,
}: {
  runs: ReadonlyArray<PipelineRunRecord>;
  title?: string;
  showTarget?: boolean;
}): JSX.Element | null {
  const { can } = useAuth();
  const canRead = can('pipelines:read');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, PipelineRunRecord>>({});
  const [updatedRuns, setUpdatedRuns] = useState<Record<string, PipelineRunRecord>>({});
  const [loadingDetail, setLoadingDetail] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const detailGeneration = useRef(0);

  const loadDetail = useCallback((runId: string): void => {
    const request = ++detailGeneration.current;
    setLoadingDetail(runId);
    void api
      .pipelineRun(runId)
      .then(({ run: detail }) => {
        if (request !== detailGeneration.current) return;
        setDetails({ [runId]: detail });
        setError(null);
      })
      .catch((err: unknown) => {
        if (request === detailGeneration.current) setError(String(err));
      })
      .finally(() => {
        if (request === detailGeneration.current) setLoadingDetail(null);
      });
  }, []);

  // List rows deliberately omit heavy detail. If an expanded run crosses its
  // terminal boundary, load once more so the final verdict/error is not the
  // earlier running snapshot.
  useEffect(() => {
    if (!canRead || !expanded || loadingDetail === expanded) return;
    const record = updatedRuns[expanded] ?? runs.find((run) => run.id === expanded);
    const detail = details[expanded];
    if (record?.status !== 'running' && detail?.status === 'running') loadDetail(expanded);
  }, [canRead, details, expanded, loadDetail, loadingDetail, runs, updatedRuns]);

  if (!canRead || runs.length === 0) return null;

  const stop = async (runId: string): Promise<void> => {
    setStopping(runId);
    setError(null);
    try {
      const { run } = await api.cancelPipelineRun(runId);
      setUpdatedRuns((current) => ({ ...current, [runId]: summarizeRun(run) }));
      if (expanded === runId) {
        detailGeneration.current++;
        setLoadingDetail(null);
        setDetails({ [runId]: run });
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setStopping(null);
    }
  };

  const toggle = (run: PipelineRunRecord): void => {
    if (expanded === run.id) {
      setExpanded(null);
      return;
    }
    setExpanded(run.id);
    if (details[run.id]) return;
    loadDetail(run.id);
  };

  return (
    <ListCard subtle>
      <div className="flex items-center gap-2 px-4 py-2.5">
        <strong className="text-sm">{title}</strong>
        <span className="dim tabular-nums">
          {runs.length} run{runs.length === 1 ? '' : 's'}
        </span>
      </div>
      <ErrorBar error={error} />

      {runs.map((run) => {
        const record = updatedRuns[run.id] ?? run;
        const open = expanded === record.id;
        const status = record.status === 'cancelled' ? 'stopped' : record.status;
        const detail = details[record.id];
        const shown = detail
          ? {
              ...record,
              steps: record.steps.map((step, index) => ({
                ...step,
                detail: detail.steps[index]?.detail ?? step.detail,
                outputs: detail.steps[index]?.outputs ?? step.outputs,
                remedies: detail.steps[index]?.remedies ?? step.remedies,
                ...(detail.steps[index]?.log ? { log: detail.steps[index]!.log } : {}),
              })),
            }
          : record;
        return (
          <div key={record.id} className="anim-in">
            <div className="flex items-stretch transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900">
              <button
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 px-4 py-2.5 text-left"
                onClick={() => toggle(record)}
                aria-expanded={open}
              >
                {record.status === 'running' ? <Spinner /> : null}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{record.pipelineName}</span>
                  <span className="dim mt-0.5 block truncate text-xs">
                    {record.trigger === 'manual'
                      ? 'manual run'
                      : record.trigger === 'pr-updated'
                        ? 'auto-run on new PR commit'
                        : `auto-run on ${record.trigger === 'issue-opened' ? 'issue' : 'PR'} open`}
                    {showTarget ? ` · ${targetLabel(record)}` : ''}
                    {record.ownerId ? ` · by ${record.ownerId}` : ''} · {timeAgo(record.createdAt)}
                  </span>
                </span>
                <span className={pipelineStatusBadge(record.status)}>{status}</span>
                <ChevronDown open={open} className="dim size-4 shrink-0" />
              </button>
              {record.status === 'running' && can('pipelines:run') ? (
                <button
                  type="button"
                  className="btn-danger-ghost my-2 mr-3 shrink-0 text-xs"
                  disabled={stopping === record.id}
                  onClick={() => void stop(record.id)}
                >
                  {stopping === record.id ? 'Stopping…' : 'Stop'}
                </button>
              ) : null}
            </div>
            {open ? (
              <div className="border-t border-zinc-100 bg-zinc-50/60 px-4 py-3 dark:border-zinc-800/60 dark:bg-zinc-900/40">
                {loadingDetail === record.id ? (
                  <div className="dim flex items-center gap-2 py-2 text-xs" role="status">
                    <Spinner /> Loading durable step history…
                  </div>
                ) : (
                  <StepRail run={shown} repo={shown.repo} number={shown.prNumber} />
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </ListCard>
  );
}
