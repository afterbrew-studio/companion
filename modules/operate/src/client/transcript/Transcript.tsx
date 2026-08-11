import { useEffect, useRef } from 'react';
import { Eyebrow, Markdown, Spinner } from '@moxxy/companion-ui';
import type { Block } from './fold.js';

export function Transcript({ blocks }: { blocks: Block[] }): React.JSX.Element {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [blocks]);

  return (
    <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto py-4">
      {blocks.length === 0 ? (
        <div className="m-auto flex shrink-0 flex-col items-center gap-1 py-16 text-center">
          <span className="text-sm font-medium text-zinc-600 dark:text-zinc-300">No messages yet</span>
          <span className="dim">Send a prompt below to start working with the agent.</span>
        </div>
      ) : null}
      {blocks.map((block) => (
        <BlockView key={block.key} block={block} />
      ))}
      <div ref={endRef} />
    </div>
  );
}

function BlockView({ block }: { block: Block }): React.JSX.Element | null {
  switch (block.kind) {
    case 'user':
      // Prompts are often long generated instructions — collapsed by default,
      // with the first line as a preview; click to expand the full text.
      return (
        <details className="group max-w-[80%] shrink-0 self-end overflow-hidden rounded-xl bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-2.5 select-none [&::-webkit-details-marker]:hidden">
            {block.trigger ? <span className="shrink-0 text-[11px] opacity-80">⚡ {block.trigger}</span> : null}
            {/* text-current: the bubble is inverted, so the eyebrow's dim gray would lose contrast. */}
            <Eyebrow className="shrink-0 text-current opacity-80">Prompt</Eyebrow>
            <span className="min-w-0 flex-1 truncate text-[13px] opacity-70 group-open:hidden">{firstLine(block.text)}</span>
            <span className="shrink-0 text-[10px] opacity-60">
              <span className="group-open:hidden">show</span>
              <span className="hidden group-open:inline">hide</span>
            </span>
          </summary>
          <pre className="border-t border-white/15 px-3.5 py-2.5 font-[inherit] text-sm whitespace-pre-wrap dark:border-zinc-900/15">
            {block.text}
          </pre>
        </details>
      );
    case 'assistant': {
      const structured = block.streaming ? null : tryParseJsonObject(block.text);
      return (
        <div className="max-w-[92%] shrink-0 self-start rounded-xl bg-zinc-100 px-3.5 py-2.5 text-sm dark:bg-zinc-800/80">
          {block.streaming ? (
            <pre className="font-[inherit] whitespace-pre-wrap">
              {block.text}
              <span className="animate-pulse">▌</span>
            </pre>
          ) : structured ? (
            <StructuredReply data={structured} />
          ) : (
            <Markdown text={block.text} />
          )}
        </div>
      );
    }
    case 'reasoning':
      // Set apart from what the agent SAID and from what it DID: reasoning is
      // neither, and giving it the same weight as either made a transcript read
      // as three kinds of statement with equal standing. Folded by default once
      // it settles, because it is worth having and rarely worth reading.
      return (
        <details
          className="group shrink-0 self-start rounded-lg border border-dashed border-zinc-200 bg-zinc-50/60 px-3 py-1.5 dark:border-zinc-800 dark:bg-zinc-900/40"
          open={block.streaming}
        >
          <summary className="dim flex cursor-pointer list-none items-center gap-2 text-xs italic select-none [&::-webkit-details-marker]:hidden">
            <span className={`shrink-0 ${block.streaming ? 'think-pulse' : 'opacity-50'}`} aria-hidden>
              ✳
            </span>
            <span>{block.streaming ? 'Thinking…' : 'Thought about it'}</span>
            <span className="text-[10px] not-italic opacity-50 group-open:hidden">show</span>
          </summary>
          <pre className="dim mt-1.5 text-xs whitespace-pre-wrap not-italic">{block.text}</pre>
        </details>
      );
    case 'tool':
      return <ToolBlock block={block} />;
    case 'notice':
      if (block.level === 'info') return <div className="chip shrink-0 self-center">{block.text}</div>;
      return <NoticeBlock block={block} />;
    default:
      return null;
  }
}

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim()) ?? '';
}

const NOTICE_TONE = {
  error: { box: 'border-red-500/40 bg-red-500/5', head: 'text-red-600 dark:text-red-400', icon: '✕', title: 'Run error' },
  warn: {
    box: 'border-amber-500/40 bg-amber-500/5',
    head: 'text-amber-700 dark:text-amber-400',
    icon: '⚠',
    title: 'Warning',
  },
} as const;

/**
 * A problem the agent hit. Amber is the common case: moxxy rides out provider
 * overload and rate limits on its own, so those arrive here while the run is
 * still working and must not be dressed as a corpse. Red is reserved for the
 * fatal kind, which is the one that actually ends the run.
 */
function NoticeBlock({ block }: { block: Extract<Block, { kind: 'notice' }> }): React.JSX.Element {
  const tone = NOTICE_TONE[block.level === 'error' ? 'error' : 'warn'];
  return (
    <div className={`flex shrink-0 items-start gap-2.5 self-stretch rounded-lg border px-3.5 py-2.5 ${tone.box}`}>
      <span className={`shrink-0 ${tone.head}`} aria-hidden>
        {tone.icon}
      </span>
      <div className="min-w-0">
        <div className={`text-[13px] font-medium ${tone.head}`}>
          {block.title ?? tone.title}
          {block.attempt ? <span className="dim ml-1.5 font-normal">attempt {block.attempt}</span> : null}
        </div>
        <pre className="mt-1 font-mono text-xs break-all whitespace-pre-wrap text-zinc-600 dark:text-zinc-300">{block.text}</pre>
      </div>
    </div>
  );
}

const TOOL_STATUS: Record<Extract<Block, { kind: 'tool' }>['status'], { label: string; cls: string }> = {
  pending: { label: 'waiting', cls: 'text-amber-600 dark:text-amber-400' },
  running: { label: 'running', cls: 'text-amber-600 dark:text-amber-400' },
  ok: { label: 'done', cls: 'text-emerald-600 dark:text-emerald-400' },
  error: { label: 'failed', cls: 'text-red-600 dark:text-red-400' },
  denied: { label: 'denied', cls: 'text-red-600 dark:text-red-400' },
};

function ToolBlock({ block }: { block: Extract<Block, { kind: 'tool' }> }): React.JSX.Element {
  const status = TOOL_STATUS[block.status];
  const busy = block.status === 'pending' || block.status === 'running';
  const summary = toolSummary(block.input);
  return (
    <details className="shrink-0 self-stretch overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3 py-2 text-[13px] transition-colors select-none hover:bg-zinc-50 dark:hover:bg-zinc-900 [&::-webkit-details-marker]:hidden">
        <span className={`flex w-4 shrink-0 justify-center ${status.cls}`} aria-hidden>
          {busy ? <Spinner /> : block.status === 'ok' ? '✓' : '✕'}
        </span>
        <span className="shrink-0 font-mono text-xs font-medium">{block.name}</span>
        {summary ? (
          <span className="dim min-w-0 flex-1 truncate font-mono text-[11px]">{summary}</span>
        ) : (
          <span className="flex-1" />
        )}
        <span className={`shrink-0 text-[11px] ${status.cls}`}>{status.label}</span>
      </summary>
      <div className="flex flex-col gap-1.5 border-t border-zinc-200 px-3 py-2.5 dark:border-zinc-800">
        <Eyebrow>Input</Eyebrow>
        <pre className="mono-pane max-h-52">{safeJson(block.input)}</pre>
        {block.detail ? (
          <>
            <Eyebrow className="mt-1">
              {block.status === 'ok' ? 'Result' : block.status === 'denied' ? 'Reason' : 'Error'}
            </Eyebrow>
            <pre className="mono-pane max-h-52">{block.detail}</pre>
          </>
        ) : null}
      </div>
    </details>
  );
}

/** Best-effort one-liner of what the tool is doing, pulled from its input. */
function toolSummary(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (typeof input !== 'object') return String(input);
  const rec = input as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt', 'description', 'title']) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  const first = Object.values(rec).find((v): v is string => typeof v === 'string' && v.trim() !== '');
  return first ?? '';
}

function safeJson(value: unknown): string {
  try {
    const raw = JSON.stringify(value, null, 2) ?? '';
    return raw.length > 1200 ? `${raw.slice(0, 1200)}…` : raw;
  } catch {
    return String(value);
  }
}

/** A full-message JSON object (agent verdict contracts) — or null. */
function tryParseJsonObject(text: string): Record<string, unknown> | null {
  const t = text.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return null;
  try {
    const v: unknown = JSON.parse(t);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function humanizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase();
}

/**
 * Structured agent replies (analysis verdicts etc.) rendered as labeled
 * sections instead of a raw JSON wall; the raw payload stays one click away.
 */
function StructuredReply({ data }: { data: Record<string, unknown> }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      {Object.entries(data).map(([key, value]) => (
        <div key={key}>
          <Eyebrow className="mb-1">{humanizeKey(key)}</Eyebrow>
          <StructuredValue value={value} ordered={/step/i.test(key)} />
        </div>
      ))}
      <details>
        <summary className="dim cursor-pointer text-xs select-none">raw JSON</summary>
        <pre className="mono-pane mt-1.5 max-h-52">{JSON.stringify(data, null, 2)}</pre>
      </details>
    </div>
  );
}

function StructuredValue({ value, ordered }: { value: unknown; ordered: boolean }): React.JSX.Element {
  if (typeof value === 'string') {
    return value.length <= 40 && !value.includes('\n') ? (
      <span className="badge normal-case">{value}</span>
    ) : (
      <p className="whitespace-pre-wrap">{value}</p>
    );
  }
  if (typeof value === 'boolean') {
    return <span className={value ? 'badge-ok' : 'badge-danger'}>{value ? 'yes' : 'no'}</span>;
  }
  if (typeof value === 'number') return <span className="tabular-nums">{value}</span>;
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    const List = ordered ? 'ol' : 'ul';
    return (
      <List className={`flex flex-col gap-1 pl-5 ${ordered ? 'list-decimal' : 'list-disc'}`}>
        {(value as string[]).map((v, i) => (
          <li key={i} className="break-words">
            {v}
          </li>
        ))}
      </List>
    );
  }
  return <pre className="mono-pane max-h-52">{JSON.stringify(value, null, 2)}</pre>;
}
