import { useEffect, useRef, useState } from 'react';
import {
  ArrowUpIcon,
  CheckIcon,
  ErrorBar,
  InlineLoading,
  Markdown,
  MicrophoneIcon,
  SparkleIcon,
  Spinner,
  StatusDot,
  StopIcon,
  UserIcon,
} from '@moxxy/companion-sdk/ui';
import { AskSheet } from '@companion/module-operate/client';
import { useAuth } from '@companion/module-core/client';
import { PreparedActions } from '@companion/module-workbench/client';
import type { DeskContextRef, DeskMissionView } from '../../contract/index.js';
import { missionStatus } from '../status.js';
import { githubContextUrl } from '../github.js';
import { useMissionConversation, type MissionToolCall } from '../hooks/useMissionConversation.js';
import { useDictation } from '../hooks/useDictation.js';

const SUGGESTIONS = [
  'Summarize this context and tell me what needs attention.',
  'Check the current state and propose the safest next action.',
  'Handle this in the background and stop only when you need my decision.',
] as const;

interface MissionChatProps {
  readonly view: DeskMissionView | null;
  readonly loading: boolean;
  readonly onBack: () => void;
}

export function MissionChat({ view, loading, onBack }: MissionChatProps): React.JSX.Element {
  const auth = useAuth();
  const conversation = useMissionConversation(view?.mission.id ?? null);
  const [input, setInput] = useState('');
  const dictation = useDictation(input, setInput, conversation.busy);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const status = view ? missionStatus({ ...view, run: conversation.run ?? view.run }) : null;

  useEffect(() => {
    dictation.stop();
    setInput('');
    inputRef.current?.focus();
  }, [dictation.stop, view?.mission.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [conversation.items, conversation.asks, conversation.busy]);

  if (!view) {
    return (
      <main className="flex min-w-0 flex-1 items-center justify-center bg-white dark:bg-zinc-950">
        {loading ? <InlineLoading label="Loading mission…" /> : (
          <div className="max-w-md px-8 text-center">
            <h1 className="text-lg font-semibold">Mission not found</h1>
            <p className="dim mt-2 text-sm">It may have been archived or removed.</p>
            <button type="button" className="btn-ghost mt-4" onClick={onBack}>Back to missions</button>
          </div>
        )}
      </main>
    );
  }

  const submit = (): void => {
    const text = input.trim();
    if (!text || conversation.busy) return;
    dictation.stop();
    setInput('');
    void conversation.send(text);
  };

  const runtime = conversation.run?.harness.label ?? view.run?.harness.label ?? view.mission.harness ?? 'Auto';
  const machine = conversation.run?.runnerId ?? view.run?.runnerId ?? view.mission.runnerId;

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-white dark:bg-zinc-950" aria-label="Mission conversation">
      <header className="shrink-0 border-b border-zinc-200 px-7 pt-5 pb-5 dark:border-zinc-800">
        <div className="flex items-center gap-2 text-xs">
          <button type="button" className="dim cursor-pointer hover:text-zinc-900 dark:hover:text-zinc-100" onClick={onBack}>Missions</button>
          <span className="dim">/</span>
          <span className="max-w-80 truncate font-medium">{view.mission.title}</span>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="min-w-0 text-2xl font-semibold tracking-tight">{view.mission.title}</h1>
          {status ? <StatusPill label={status.label === 'Review' || status.label === 'Needs you' ? 'Needs review' : status.label} tone={status.tone} pulse={status.pulse} /> : null}
          <span className="dim text-xs">·</span>
          <span className="dim text-xs">{runtime}</span>
          <span className="dim text-xs">·</span>
          <span className="dim text-xs">{machine ? 'Remote' : 'Local'}</span>
          <MissionContextLinks contexts={view.mission.contexts} githubHost={auth.githubHost} />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
        <div className="mx-auto flex min-h-full max-w-4xl flex-col">
          {conversation.loading ? (
            <InlineLoading label="Opening mission transcript…" />
          ) : conversation.items.length === 0 ? (
            <div className="my-auto py-10">
              <div className="flex items-start gap-4">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                  <SparkleIcon className="size-4" />
                </span>
                <div>
                  <div className="text-xs font-semibold">Companion</div>
                  <h2 className="mt-2 text-xl font-semibold">What should I handle?</h2>
                  <p className="dim mt-2 max-w-xl text-sm leading-relaxed">
                    Describe the outcome normally. This mission keeps its own context and continues running while you work elsewhere.
                  </p>
                  <div className="mt-5 grid max-w-2xl gap-2">
                    {SUGGESTIONS.map((suggestion) => (
                      <button
                        key={suggestion}
                        type="button"
                        className="cursor-pointer rounded-lg border border-zinc-200 px-3.5 py-2.5 text-left text-xs text-zinc-600 transition-colors hover:border-zinc-400 hover:text-zinc-900 dark:border-zinc-800 dark:text-zinc-300 dark:hover:border-zinc-600 dark:hover:text-zinc-100"
                        onClick={() => void conversation.send(suggestion)}
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-7">
              {conversation.items.map((item, index) => item.kind === 'user' ? (
                <div key={index} className="anim-in flex items-start gap-4">
                  <span className="dim mt-2 flex size-8 shrink-0 items-center justify-center"><UserIcon className="size-5" /></span>
                  <div className="max-w-3xl flex-1 rounded-xl border border-zinc-200 bg-zinc-50/50 px-4 py-3.5 dark:border-zinc-800 dark:bg-zinc-900/40">
                    <div className="text-xs font-semibold">You</div>
                    <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap">{item.text}</p>
                  </div>
                </div>
              ) : item.kind === 'assistant' ? (
                <div key={index} className="anim-in flex items-start gap-4">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                    <SparkleIcon className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1 pt-1">
                    <div className="text-xs font-semibold">Companion</div>
                    <div className={`markdown mt-3 max-w-none text-sm leading-relaxed ${item.streaming ? 'mission-streaming-mark' : ''}`}><Markdown text={item.text} /></div>
                  </div>
                </div>
              ) : item.kind === 'tool' ? (
                <div key={index} className="anim-in ml-12 max-w-xl">
                  <ToolProgress calls={item.calls} busy={conversation.busy} />
                </div>
              ) : (
                <div key={index} className={`ml-12 ${item.level === 'warn' ? 'rounded-lg border border-amber-500/30 bg-amber-500/5 px-3.5 py-2.5 text-sm text-amber-700 dark:text-amber-400' : 'error-bar'}`}>
                  {item.text}
                </div>
              ))}
            </div>
          )}
          {conversation.busy && !conversation.items.some((item) => item.kind === 'tool') ? (
            <div className="ml-12 mt-5 flex max-w-xl items-center gap-3 rounded-xl border border-zinc-200 px-4 py-3 text-xs dark:border-zinc-800">
              <Spinner /> Companion is working through the request
            </div>
          ) : null}
          {conversation.asks.map((ask) => (
            <div className="ml-12 mt-5" key={ask.requestId}>
              <AskSheet ask={ask} onRespond={(response) => void conversation.respondAsk(ask.requestId, response)} />
            </div>
          ))}
          <div className="ml-12">
            <PreparedActions workspaceId={view.mission.workspaceId} compact />
          </div>
          <ErrorBar error={conversation.error} className="mt-4 ml-12" />
          <div ref={bottomRef} />
        </div>
      </div>

      <form
        className="shrink-0 px-7 pt-3 pb-6"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="mx-auto max-w-4xl rounded-xl border border-zinc-300 bg-white px-4 pt-3 pb-3 shadow-sm transition-colors focus-within:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:focus-within:border-zinc-500">
          <textarea
            ref={inputRef}
            rows={2}
            className="max-h-40 min-h-12 w-full resize-none border-none bg-transparent py-1 text-sm outline-none placeholder:text-zinc-400 disabled:cursor-not-allowed disabled:opacity-70"
            placeholder={conversation.busy ? 'This mission is working…' : 'Ask a follow-up…'}
            value={input}
            disabled={conversation.busy}
            onChange={(event) => {
              dictation.clearError();
              setInput(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <div className="flex items-center gap-2">
            <span className={`min-w-0 flex-1 truncate text-[11px] ${dictation.error ? 'text-red-600 dark:text-red-400' : 'dim'}`}>
              {dictation.error ?? (dictation.listening
                ? 'Listening… speak naturally'
                : view.mission.contexts.length > 0
                ? `${view.mission.contexts.length} context ${view.mission.contexts.length === 1 ? 'item' : 'items'} attached`
                : 'Workspace and repository scope are included')}
            </span>
            {conversation.busy ? (
              <>
                <button type="button" className="cursor-pointer text-xs font-medium text-red-600 hover:text-red-700 dark:text-red-400" onClick={() => void conversation.abort()}>Stop</button>
                <button type="button" className="flex size-8 cursor-pointer items-center justify-center rounded-lg border border-zinc-200 text-red-600 hover:bg-red-500/5 dark:border-zinc-700 dark:text-red-400" onClick={() => void conversation.abort()} aria-label="Stop turn">
                  <StopIcon className="size-3.5" />
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className={`flex size-8 cursor-pointer items-center justify-center rounded-lg border transition-colors disabled:cursor-default disabled:opacity-40 ${
                    dictation.listening
                      ? 'border-red-300 bg-red-50 text-red-600 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-400'
                      : 'border-zinc-200 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100'
                  }`}
                  disabled={!dictation.supported}
                  onClick={dictation.toggle}
                  aria-label={dictation.listening ? 'Stop dictation' : 'Start dictation'}
                  aria-pressed={dictation.listening}
                  title={dictation.supported ? (dictation.listening ? 'Stop dictation' : 'Dictate message') : 'Voice dictation is not supported by this browser'}
                >
                  <MicrophoneIcon />
                </button>
                <button type="submit" className="btn flex size-8 items-center justify-center p-0" disabled={!input.trim()} aria-label="Send message">
                  <ArrowUpIcon />
                </button>
              </>
            )}
          </div>
        </div>
      </form>
    </main>
  );
}

function MissionContextLinks({ contexts, githubHost }: { readonly contexts: readonly DeskContextRef[]; readonly githubHost: string }): React.JSX.Element {
  const [moreOpen, setMoreOpen] = useState(false);
  const visible = contexts.slice(0, 1);
  const overflow = contexts.slice(1);

  return (
    <>
      {visible.map((context) => (
        <span key={`${context.kind}:${context.repo}#${context.number}`} className="contents">
          <span className="dim text-xs">·</span>
          <ContextLink context={context} githubHost={githubHost} />
        </span>
      ))}
      {overflow.length > 0 ? (
        <>
          <span className="dim text-xs">·</span>
          <span
            className="relative"
            onMouseEnter={() => setMoreOpen(true)}
            onMouseLeave={() => setMoreOpen(false)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMoreOpen(false);
            }}
          >
            <button
              type="button"
              className="dim cursor-pointer text-xs hover:text-zinc-900 hover:underline dark:hover:text-zinc-100"
              onFocus={() => setMoreOpen(true)}
              onClick={() => setMoreOpen(true)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setMoreOpen(false);
              }}
              aria-haspopup="menu"
              aria-expanded={moreOpen}
            >
              +{overflow.length} more
            </button>
            <span
              className={`absolute top-full right-0 z-30 w-72 pt-2 transition-[opacity,transform] duration-150 ${moreOpen ? 'pointer-events-auto translate-y-0 opacity-100' : 'pointer-events-none -translate-y-1 opacity-0'}`}
              aria-hidden={!moreOpen}
              inert={!moreOpen}
            >
              <span className="block max-h-64 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-1.5 shadow-xl dark:border-zinc-700 dark:bg-zinc-900" role="menu" aria-label="More attached context">
                <span className="dim block border-b border-zinc-100 px-3 py-2 text-[9px] font-medium tracking-wide uppercase dark:border-zinc-800" aria-hidden>Attached context</span>
                {overflow.map((context) => (
                  <a
                    key={`${context.kind}:${context.repo}#${context.number}`}
                    href={githubContextUrl(githubHost, context.repo, context.kind, context.number)}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-3 rounded-md px-3 py-2 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    role="menuitem"
                  >
                    <span className="shrink-0 font-medium">{context.kind === 'pull-request' ? 'PR' : 'Issue'} #{context.number}</span>
                    <span className="dim min-w-0 flex-1 truncate text-[10px]">{context.repo}</span>
                  </a>
                ))}
              </span>
            </span>
          </span>
        </>
      ) : null}
    </>
  );
}

function ContextLink({ context, githubHost }: { readonly context: DeskContextRef; readonly githubHost: string }): React.JSX.Element {
  return (
    <a
      href={githubContextUrl(githubHost, context.repo, context.kind, context.number)}
      target="_blank"
      rel="noreferrer"
      className="dim text-xs hover:text-zinc-900 hover:underline dark:hover:text-zinc-100"
      title={context.repo}
    >
      {context.kind === 'pull-request' ? 'PR' : 'Issue'} #{context.number}
    </a>
  );
}

function StatusPill({ label, tone, pulse }: { readonly label: string; readonly tone: 'blue' | 'amber' | 'red' | 'green' | 'zinc'; readonly pulse: boolean }): React.JSX.Element {
  const cls = tone === 'green'
    ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    : tone === 'amber'
      ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
      : tone === 'red'
        ? 'bg-red-500/10 text-red-700 dark:text-red-300'
        : tone === 'blue'
          ? 'bg-blue-500/10 text-blue-700 dark:text-blue-300'
          : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300';
  return <span className={`inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-[11px] font-medium ${cls}`}><StatusDot tone={tone} pulse={pulse} size="sm" />{label}</span>;
}

function ToolProgress({ calls, busy }: { readonly calls: readonly MissionToolCall[]; readonly busy: boolean }): React.JSX.Element {
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950" aria-label="Mission progress">
      {calls.map((call, index) => {
        const active = call.status === 'pending' || call.status === 'running';
        const failed = call.status === 'error' || call.status === 'denied';
        const summary = toolDescription(call.name, call.input);
        const total = durationBetween(call.requestedAt, call.completedAt);
        return (
          <details key={call.callId} className="group border-b border-zinc-100 last:border-b-0 dark:border-zinc-900">
            <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 px-4 py-2.5 text-xs transition-colors select-none hover:bg-zinc-50 dark:hover:bg-zinc-900 [&::-webkit-details-marker]:hidden">
              <span className={`flex size-5 shrink-0 items-center justify-center rounded-full border ${
                call.status === 'ok'
                  ? 'border-emerald-500 text-emerald-600 dark:text-emerald-400'
                  : failed
                    ? 'border-red-400 text-red-600 dark:text-red-400'
                    : 'border-zinc-300 text-zinc-400 dark:border-zinc-700'
              }`}>
                {call.status === 'ok' ? <CheckIcon className="size-3" /> : active ? <Spinner /> : failed ? '×' : index + 1}
              </span>
              <span className="shrink-0 font-medium">{humanizeTool(call.name)}</span>
              {summary ? <span className="dim min-w-0 flex-1 truncate text-[10px]">{summary}</span> : <span className="flex-1" />}
              {total !== null ? <span className="dim shrink-0 tabular-nums text-[10px]">{formatDuration(total)}</span> : null}
              <span className={call.status === 'ok' ? 'shrink-0 text-emerald-600 dark:text-emerald-400' : failed ? 'shrink-0 text-red-600 dark:text-red-400' : 'dim shrink-0'}>
                {call.status === 'ok' ? 'Completed' : call.status === 'denied' ? 'Denied' : call.status === 'error' ? 'Failed' : active && busy ? 'Working…' : 'Queued'}
              </span>
              <span className="dim ml-1 shrink-0 transition-transform duration-150 group-open:rotate-90" aria-hidden>›</span>
            </summary>
            <ToolDetails call={call} />
          </details>
        );
      })}
    </div>
  );
}

function ToolDetails({ call }: { readonly call: MissionToolCall }): React.JSX.Element {
  const queueDuration = durationBetween(call.requestedAt, call.startedAt);
  const executionDuration = durationBetween(call.startedAt ?? call.requestedAt, call.completedAt);
  const totalDuration = durationBetween(call.requestedAt, call.completedAt);
  return (
    <div className="border-t border-zinc-100 bg-zinc-50/60 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/40">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-[10px] sm:grid-cols-3">
        <ToolMeta label="Requested" value={formatTimestamp(call.requestedAt)} />
        <ToolMeta label="Queue / approval" value={formatOptionalDuration(queueDuration)} />
        <ToolMeta label="Execution" value={call.completedAt !== null ? formatOptionalDuration(executionDuration) : 'In progress'} />
        <ToolMeta label="Total" value={call.completedAt !== null ? formatOptionalDuration(totalDuration) : 'In progress'} />
        <ToolMeta label="Approval" value={call.decision ?? 'Not recorded'} />
        <ToolMeta label="Call ID" value={call.callId} mono />
      </dl>

      <div className="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
        <div className="dim mb-1.5 text-[9px] font-medium tracking-wide uppercase">Input</div>
        <pre className="max-h-56 overflow-auto rounded-lg bg-zinc-950 p-3 font-mono text-[10px] leading-relaxed break-words whitespace-pre-wrap text-zinc-100 dark:bg-black">{safeToolValue(call.input)}</pre>
      </div>

      {call.detail ? (
        <div className="mt-3">
          <div className="dim mb-1.5 text-[9px] font-medium tracking-wide uppercase">{call.status === 'ok' ? 'Result' : call.status === 'denied' ? 'Reason' : 'Error'}</div>
          <pre className="max-h-64 overflow-auto rounded-lg bg-zinc-950 p-3 font-mono text-[10px] leading-relaxed break-words whitespace-pre-wrap text-zinc-100 dark:bg-black">{call.detail}</pre>
        </div>
      ) : null}
    </div>
  );
}

function ToolMeta({ label, value, mono = false }: { readonly label: string; readonly value: string; readonly mono?: boolean }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="dim">{label}</dt>
      <dd className={`mt-0.5 truncate ${mono ? 'font-mono' : 'tabular-nums'}`} title={value}>{value}</dd>
    </div>
  );
}

function toolDescription(name: string, input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return shellLikeTool(name) ? 'Run shell command' : input;
  if (typeof input !== 'object') return String(input);
  const record = input as Record<string, unknown>;
  const description = record.description;
  if (typeof description === 'string' && description.trim()) return description;
  if (shellLikeTool(name) || typeof record.command === 'string' || typeof record.cmd === 'string') {
    return 'Run shell command';
  }
  for (const key of ['file_path', 'path', 'pattern', 'query', 'url', 'prompt']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function shellLikeTool(name: string): boolean {
  return /^(bash|shell|exec_command|command_execution)$/i.test(name);
}

function safeToolValue(value: unknown): string {
  if (value === undefined) return 'No input recorded.';
  try {
    const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (!raw) return 'No input recorded.';
    return raw.length > 8_000 ? `${raw.slice(0, 8_000)}…` : raw;
  } catch {
    return String(value);
  }
}

function durationBetween(start: number | null, end: number | null): number | null {
  if (start === null || end === null || end < start) return null;
  return end - start;
}

function formatOptionalDuration(duration: number | null): string {
  return duration === null ? 'Not recorded' : formatDuration(duration);
}

function formatDuration(duration: number): string {
  if (duration < 1_000) return `${Math.max(1, Math.round(duration))} ms`;
  if (duration < 60_000) return `${(duration / 1_000).toFixed(duration < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(duration / 60_000);
  const seconds = Math.round((duration % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function formatTimestamp(timestamp: number | null): string {
  if (timestamp === null) return 'Not recorded';
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function humanizeTool(name: string): string {
  return name
    .replace(/^mcp__[^_]+__/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (letter) => letter.toUpperCase());
}
