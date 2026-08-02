import { useState } from 'react';
import { ErrorBar, Field, FormActions, Modal, Spinner } from '@moxxy/companion-sdk/ui';
import type { PipelineRecord, PipelineRunRecord } from '../../../contract/index.js';
import { PipelineRunList } from '../../components/PipelineRunList.js';

/**
 * Our own pipeline runs against this PR (checks gate → AI review → agent steps).
 * Renders nothing when there are none — an empty section isn't worth the space;
 * starting a pipeline lives in the header's AI menu.
 */
export function PrPipelines({
  runs,
}: {
  runs: PipelineRunRecord[];
}): JSX.Element | null {
  return runs.length > 0 ? (
    <section aria-label="Pipelines">
      <PipelineRunList runs={runs} />
    </section>
  ) : null;
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
  const [error, setError] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await onRun(selected);
      onClose();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  const chosen = pipelines.find((p) => p.id === selected);

  return (
    <Modal title="Run pipeline" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <ErrorBar error={error} />
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
