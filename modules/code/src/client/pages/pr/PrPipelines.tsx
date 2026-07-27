import { useState } from 'react';
import { ChevronDown, Field, FormActions, ListCard, Markdown, Modal, Spinner, timeAgo } from '@moxxy-ai/companion-sdk/ui';
import type { PipelineRecord, PipelineRunRecord } from '../../../contract/index.js';
import { pipelineStatusBadge } from '../../widgets.js';

/**
 * Our own pipeline runs against this PR (checks gate → AI review → agent steps).
 * Renders nothing when there are none — an empty section isn't worth the space;
 * starting a pipeline lives in the header's AI menu.
 */
export function PrPipelines({ runs }: { runs: PipelineRunRecord[] }): JSX.Element | null {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (runs.length === 0) return null;

  return (
    <section aria-label="Pipelines">
      <ListCard subtle>
        <div className="flex items-center gap-2 px-4 py-2.5">
          <strong className="text-sm">Pipelines</strong>
          <span className="dim tabular-nums">
            {runs.length} run{runs.length === 1 ? '' : 's'}
          </span>
        </div>

        {runs.map((r) => (
          <div key={r.id} className="anim-in">
            <button
              className="flex w-full cursor-pointer items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900"
              onClick={() => setExpanded((v) => (v === r.id ? null : r.id))}
              aria-expanded={expanded === r.id}
            >
              {r.status === 'running' ? <Spinner /> : null}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{r.pipelineName}</span>
                <span className="dim mt-0.5 block text-xs">
                  {r.trigger === 'pr-opened' ? 'auto-run on PR open' : 'manual run'} · {timeAgo(r.createdAt)}
                </span>
              </span>
              <span className={pipelineStatusBadge(r.status)}>{r.status}</span>
              <ChevronDown open={expanded === r.id} className="dim size-4 shrink-0" />
            </button>
            {expanded === r.id ? (
              <ol
                className="flex flex-col gap-2 border-t border-zinc-100 bg-zinc-50/60 px-4 py-3 dark:border-zinc-800/60 dark:bg-zinc-900/40"
                aria-label="Step results"
              >
                {r.steps.map((s, i) => (
                  <li key={i} className="flex items-start gap-2 text-[13px]">
                    <span className={pipelineStatusBadge(s.status)}>{s.status}</span>
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{s.name}</div>
                      {s.summary ? <div className="dim">{s.summary}</div> : null}
                      {s.detail ? (
                        <details className="mt-0.5">
                          <summary className="dim cursor-pointer text-xs">detail</summary>
                          <div className="mt-1 max-h-48 overflow-y-auto">
                            <Markdown text={s.detail} />
                          </div>
                        </details>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
        ))}
      </ListCard>
    </section>
  );
}

/** Pick a pipeline and run it against this PR (reached from the AI menu). */
export function RunPipelineModal({
  pipelines,
  onRun,
  onClose,
}: {
  pipelines: PipelineRecord[];
  onRun: (pipelineId: string) => Promise<void>;
  onClose: () => void;
}): JSX.Element {
  const [selected, setSelected] = useState(pipelines[0]?.id ?? '');
  const [busy, setBusy] = useState(false);

  const run = async (): Promise<void> => {
    if (!selected) return;
    setBusy(true);
    try {
      await onRun(selected);
      onClose();
    } catch {
      setBusy(false);
    }
  };

  const chosen = pipelines.find((p) => p.id === selected);

  return (
    <Modal title="Run pipeline" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Pipeline">
          <select className="input" value={selected} onChange={(e) => setSelected(e.target.value)} autoFocus>
            {pipelines.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        {chosen?.description ? <p className="dim text-[13px]">{chosen.description}</p> : null}
        <FormActions>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={!selected || busy} onClick={() => void run()}>
            {busy ? (
              <>
                <Spinner /> Starting…
              </>
            ) : (
              'Run pipeline'
            )}
          </button>
        </FormActions>
      </div>
    </Modal>
  );
}
