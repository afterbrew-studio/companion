import { useEffect, useRef, useState } from 'react';
import { onServerMessage } from '@moxxy/companion-sdk/client';

/** Enough to see what a command is doing without holding a whole build log. */
const MAX_LINES = 400;

/**
 * A running command's output, as it arrives.
 *
 * Exists because a step that takes twenty minutes with nothing on screen reads
 * as hung. The finished output is kept on the run record; this is only the live
 * view, so it holds a bounded tail in memory and nothing at all once the page
 * is left.
 *
 * Chunks are already scrubbed server-side, across chunk boundaries. Nothing
 * here re-checks that, and nothing here should: a client-side scrub would be a
 * second implementation of the same rule, drifting from the one that counts.
 */
export function StepOutput({ runId, stepIndex }: { runId: string; stepIndex: number }): JSX.Element | null {
  const [text, setText] = useState('');
  const box = useRef<HTMLPreElement>(null);
  // Only stick to the bottom while the reader is already there, so scrolling up
  // to read something is not undone by the next chunk.
  const pinned = useRef(true);

  // Subscribed directly rather than through useLive: this panel consumes a
  // stream, it does not refetch on a signal, and useLive's predicate is not a
  // place to put side effects.
  useEffect(
    () =>
      onServerMessage((msg) => {
        if (msg.t !== 'pipelineStep.output' || msg.runId !== runId || msg.stepIndex !== stepIndex) return;
        setText((prev) => {
          const next = prev + msg.chunk;
          const lines = next.split('\n');
          return lines.length > MAX_LINES ? lines.slice(-MAX_LINES).join('\n') : next;
        });
      }),
    [runId, stepIndex],
  );

  useEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  if (!text) return null;

  return (
    <pre
      ref={box}
      className="mt-1.5 max-h-56 overflow-auto rounded bg-zinc-950/60 p-2 font-mono text-[11px] leading-relaxed text-zinc-300"
      aria-label="Live command output"
      aria-live="polite"
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {text}
    </pre>
  );
}
