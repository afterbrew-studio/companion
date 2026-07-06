import { useEffect, useRef } from 'react';
import type { Block } from './fold.js';

export function Transcript({ blocks }: { blocks: Block[] }): JSX.Element {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [blocks]);

  return (
    <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto py-4">
      {blocks.map((block) => (
        <BlockView key={block.key} block={block} />
      ))}
      <div ref={endRef} />
    </div>
  );
}

function BlockView({ block }: { block: Block }): JSX.Element | null {
  switch (block.kind) {
    case 'user':
      return (
        <div className="max-w-[80%] self-end rounded-xl bg-indigo-600 px-3.5 py-2.5 text-sm text-white dark:bg-indigo-500 dark:text-zinc-950">
          {block.trigger ? <div className="mb-1 text-[11px] opacity-80">⚡ {block.trigger}</div> : null}
          <pre className="font-[inherit] whitespace-pre-wrap">{block.text}</pre>
        </div>
      );
    case 'assistant':
      return (
        <div className="max-w-[92%] self-start rounded-xl bg-zinc-100 px-3.5 py-2.5 text-sm dark:bg-zinc-800/80">
          <pre className="font-[inherit] whitespace-pre-wrap">
            {block.text}
            {block.streaming ? <span className="animate-pulse">▌</span> : null}
          </pre>
        </div>
      );
    case 'reasoning':
      return (
        <details
          className="rounded-xl border border-dashed border-zinc-300 px-3.5 py-2 text-xs text-zinc-500 dark:border-zinc-700 dark:text-zinc-400"
          open={block.streaming}
        >
          <summary className="cursor-pointer">thinking{block.streaming ? '…' : ''}</summary>
          <pre className="mt-1.5 whitespace-pre-wrap">{block.text}</pre>
        </details>
      );
    case 'tool': {
      const dot =
        block.status === 'ok'
          ? 'bg-emerald-500'
          : block.status === 'error' || block.status === 'denied'
            ? 'bg-red-500'
            : 'bg-amber-500';
      return (
        <details className="rounded-xl border border-zinc-200 px-3.5 py-2 text-[13px] dark:border-zinc-800">
          <summary className="flex cursor-pointer items-center gap-2">
            <span className={`inline-block h-2 w-2 rounded-full ${dot}`} /> {block.name}
            <span className="dim ml-auto">{block.status}</span>
          </summary>
          <pre className="mono-pane mt-2 max-h-52">{safeJson(block.input)}</pre>
          {block.detail ? <pre className="mono-pane mt-1.5 max-h-52">{block.detail}</pre> : null}
        </details>
      );
    }
    case 'notice':
      return (
        <div
          className={`self-center text-xs ${
            block.level === 'error' ? 'text-red-600 dark:text-red-400' : 'text-zinc-500 dark:text-zinc-400'
          }`}
        >
          {block.text}
        </div>
      );
    default:
      return null;
  }
}

function safeJson(value: unknown): string {
  try {
    const raw = JSON.stringify(value, null, 2) ?? '';
    return raw.length > 1200 ? `${raw.slice(0, 1200)}…` : raw;
  } catch {
    return String(value);
  }
}
