import { useCallback, useEffect, useRef, useState } from 'react';
import { onServerMessage, onWsState } from '@moxxy/companion-sdk/client';
import {
  MAX_PIPELINE_STEP_LOG_CHARS,
  type PipelineStepLog,
} from '../../contract/index.js';
import { codeApi as api } from '../api.js';

/** Enough to inspect the current failure without rendering a whole build log. */
const MAX_RENDERED_LINES = 400;

/**
 * A command's durable output tail.
 *
 * The owner receives sequenced chunks immediately. Everyone with authenticated
 * repo access reconciles from the bounded REST snapshot every two seconds and
 * after a WS reconnect, so refreshes and short disconnects never blank the log.
 */
export function StepOutput({
  runId,
  stepIndex,
  initialLog,
  running,
}: {
  runId: string;
  stepIndex: number;
  initialLog?: PipelineStepLog | null;
  running: boolean;
}): React.JSX.Element | null {
  const [log, setLog] = useState<PipelineStepLog | null>(initialLog ?? null);
  const [error, setError] = useState<string | null>(null);
  const [showFullTail, setShowFullTail] = useState(false);
  const sequence = useRef(initialLog?.sequence ?? 0);
  const refreshGeneration = useRef(0);
  const box = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);

  const reconcile = useCallback((next: PipelineStepLog | null): void => {
    if (!next || next.sequence <= sequence.current) return;
    sequence.current = next.sequence;
    setLog(next);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const request = ++refreshGeneration.current;
    try {
      const result = await api.pipelineStepLog(runId, stepIndex, sequence.current);
      if (request !== refreshGeneration.current) return;
      reconcile(result.log);
      setError(null);
    } catch (err) {
      if (request === refreshGeneration.current) setError(String(err));
    }
  }, [reconcile, runId, stepIndex]);

  useEffect(() => {
    sequence.current = 0;
    refreshGeneration.current++;
    setLog(null);
    setShowFullTail(false);
    pinned.current = true;
  }, [runId, stepIndex]);

  useEffect(() => reconcile(initialLog ?? null), [initialLog, reconcile]);

  useEffect(() => {
    // Always reconcile once, including on running → terminal. A non-owner may
    // otherwise miss the final sub-two-second flush between their last poll and
    // the terminal pipelineRuns.changed event.
    void refresh();
    if (!running) return;
    const timer = setInterval(() => void refresh(), 2_000);
    return () => clearInterval(timer);
  }, [refresh, running]);

  useEffect(
    () =>
      onWsState((state) => {
        if (state === 'connected') void refresh();
      }),
    [refresh],
  );

  useEffect(
    () =>
      onServerMessage((msg) => {
        if (msg.t !== 'pipelineStep.output' || msg.runId !== runId || msg.stepIndex !== stepIndex) return;
        if (msg.sequence <= sequence.current) return;
        if (msg.sequence !== sequence.current + 1) {
          void refresh();
          return;
        }
        sequence.current = msg.sequence;
        setLog((previous) => {
          const combined = (previous?.text ?? '') + msg.chunk;
          const clipped = combined.length > MAX_PIPELINE_STEP_LOG_CHARS;
          return {
            text: clipped ? combined.slice(-MAX_PIPELINE_STEP_LOG_CHARS) : combined,
            sequence: msg.sequence,
            truncated: (previous?.truncated ?? false) || clipped,
            updatedAt: Date.now(),
          };
        });
      }),
    [refresh, runId, stepIndex],
  );

  useEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [log?.text]);

  const lines = log?.text.split('\n') ?? [];
  const lineClipped = lines.length > MAX_RENDERED_LINES;
  const rendered = lineClipped && !showFullTail ? lines.slice(-MAX_RENDERED_LINES).join('\n') : log?.text;
  if (!rendered && !error) return null;

  return (
    <div className="mt-1.5">
      <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px]">
        <span className="dim">{running ? 'Live command output' : 'Command output'}</span>
        {log?.truncated ? <span className="badge-warn">64k tail</span> : null}
        {lineClipped ? (
          <button type="button" className="linkish" onClick={() => setShowFullTail((shown) => !shown)}>
            {showFullTail ? 'Show latest 400 lines' : 'Show full retained tail'}
          </button>
        ) : null}
        {error ? (
          <span className="flex items-center gap-1 text-red-500">
            could not refresh output
            <button type="button" className="linkish" onClick={() => void refresh()}>
              Retry
            </button>
          </span>
        ) : null}
      </div>
      {rendered ? (
        // Re-announcing the whole retained tail for every chunk overwhelms a
        // screen reader; the adjacent step status already announces progress.
        <pre
          ref={box}
          className="max-h-56 overflow-auto rounded bg-zinc-950/60 p-2 font-mono text-[11px] leading-relaxed text-zinc-300"
          aria-label={running ? 'Live command output' : 'Command output'}
          aria-live="off"
          onScroll={(event) => {
            const el = event.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          {rendered}
        </pre>
      ) : null}
    </div>
  );
}
