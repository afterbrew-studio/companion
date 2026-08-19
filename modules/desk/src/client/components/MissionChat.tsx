import { useEffect, useRef, useState } from 'react';
import {
  ArrowUpIcon,
  CheckIcon,
  ErrorBar,
  Markdown,
  MicrophoneIcon,
  SparkleIcon,
  Spinner,
  StatusDot,
  StopIcon,
  Tooltip,
  UserIcon,
} from '@moxxy/companion-sdk/ui';
import { useAuth } from '@companion/module-core/client';
import { AskSheet } from '@companion/module-operate/client';
import { PreparedActions } from '@companion/module-workbench/client';
import type { DeskContextRef, DeskMissionView } from '../../contract/index.js';
import { githubContextUrl } from '../github.js';
import { missionStatus } from '../status.js';
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
    if (loading) return <MissionChatSkeleton />;
    return (
      <main className="flex min-w-0 flex-1 items-center justify-center">
        <div className="max-w-md px-8 text-center">
          <h1 className="text-lg font-semibold">Mission not found</h1>
          <p className="dim mt-2 text-sm">It may have been archived or removed.</p>
          <button type="button" className="btn-ghost mt-4" onClick={onBack}>Back to missions</button>
        </div>
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
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden" aria-label="Mission conversation">
      <header className="shrink-0 pt-1 pb-5">
        <div className="flex items-center gap-2 text-xs">
          <button type="button" className="dim cursor-pointer hover:text-zinc-900 dark:hover:text-zinc-100" onClick={onBack}>Missions</button>
          <span className="dim">/</span>
          <span className="max-w-80 truncate font-medium">{view.mission.title}</span>
        </div>
        <div className="mt-5 min-w-0">
          <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight" title={view.mission.title}>{view.mission.title}</h1>
          {status ? (
            <div className="dim mt-2 flex flex-wrap items-center gap-2 text-xs">
              <span className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300">
                <StatusDot tone={status.tone} pulse={status.pulse} size="sm" />
                {status.label === 'Review' || status.label === 'Needs you' ? 'Needs review' : status.label}
              </span>
              <span>·</span>
              <span>{runtime}</span>
              <span>·</span>
              <span>{machine ? 'Remote' : 'Local'}</span>
              <MissionContextMetadata contexts={view.mission.contexts} githubHost={auth.githubHost} />
            </div>
          ) : null}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto py-6">
        <div className="flex min-h-full w-full flex-col">
          {conversation.loading ? (
            <TranscriptSkeleton />
          ) : conversation.items.length === 0 ? (
            <div className="my-auto py-10">
              <div className="flex items-start gap-4">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                  <SparkleIcon className="size-4" />
                </span>
                <div>
                  <div className="text-xs font-semibold">Companion</div>
                  <h2 className="mt-2 text-xl font-semibold">What should I handle?</h2>
                  <p className="dim mt-2 text-sm leading-relaxed">
                    Describe the outcome normally. This mission keeps its own context and continues running while you work elsewhere.
                  </p>
                  <div className="mt-5 grid gap-2">
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
                  <div className="flex-1 rounded-xl border border-zinc-200 bg-zinc-50/50 px-4 py-3.5 dark:border-zinc-800 dark:bg-zinc-900/40">
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
                <div key={index} className="anim-in ml-12">
                  <ToolProgress calls={item.calls} busy={conversation.busy} />
                </div>
              ) : (
                <div key={index} className={`ml-12 ${item.level === 'warn' ? 'rounded-lg border border-amber-500/30 bg-amber-500/5 px-3.5 py-2.5 text-sm text-amber-700 dark:text-amber-400' : 'error-bar'}`}>
                  {item.text}
                </div>
              ))}
            </div>
          )}
          {conversation.busy
            && !conversation.items.some((item) => item.kind === 'tool')
            && conversation.items.at(-1)?.kind !== 'assistant' ? (
            <div className="mt-5"><AssistantReplySkeleton compact /></div>
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
        className="shrink-0 pt-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="w-full rounded-xl border border-zinc-300 bg-white px-4 pt-3 pb-3 shadow-sm transition-colors focus-within:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:focus-within:border-zinc-500">
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

function MissionContextMetadata({ contexts, githubHost }: { readonly contexts: readonly DeskContextRef[]; readonly githubHost: string }): React.JSX.Element | null {
  const primary = contexts[0];
  if (!primary) return null;
  const overflow = contexts.slice(1);
  return (
    <>
      <span>·</span>
      <a href={githubContextUrl(githubHost, primary.repo, primary.kind, primary.number)} target="_blank" rel="noreferrer" className="hover:text-zinc-900 hover:underline dark:hover:text-zinc-100">
        {contextLabel(primary)}
      </a>
      {overflow.length > 0 ? (
        <>
          <span>·</span>
          <Tooltip
            side="bottom"
            content={<span className="block space-y-1">{overflow.map((context) => <span key={`${context.kind}:${context.repo}#${context.number}`} className="block">{contextLabel(context)} · {context.repo}</span>)}</span>}
          >
            <span className="cursor-help hover:text-zinc-900 dark:hover:text-zinc-100">+{overflow.length} more</span>
          </Tooltip>
        </>
      ) : null}
    </>
  );
}

function contextLabel(context: DeskContextRef): string {
  return `${context.kind === 'pull-request' ? 'PR' : 'Issue'} #${context.number}`;
}

function MissionChatSkeleton(): React.JSX.Element {
  const line = 'animate-pulse rounded bg-zinc-200 motion-reduce:animate-none dark:bg-zinc-800';
  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden" aria-label="Loading mission" aria-busy="true">
      <header className="shrink-0 pt-1 pb-5">
        <div className={`${line} h-3 w-48`} />
        <div className={`${line} mt-5 h-7 w-[min(30rem,65%)]`} />
        <div className="mt-3 flex items-center gap-2">
          <div className={`${line} size-2 rounded-full`} />
          <div className={`${line} h-3 w-20`} />
          <div className={`${line} h-3 w-16`} />
          <div className={`${line} h-3 w-14`} />
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden py-6">
        <div className="w-full"><TranscriptSkeleton /></div>
      </div>
      <div className="shrink-0 pt-3">
        <div className="min-h-24 w-full rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
          <div className={`${line} h-3 w-52`} />
          <div className="mt-8 flex items-center justify-between">
            <div className={`${line} h-3 w-64`} />
            <div className={`${line} size-8 rounded-lg`} />
          </div>
        </div>
      </div>
    </main>
  );
}

function TranscriptSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-7" aria-label="Loading mission transcript">
      <div className="flex items-start gap-4">
        <SkeletonCircle />
        <div className="min-h-24 flex-1 rounded-xl border border-zinc-200 bg-zinc-50/50 px-4 py-3.5 dark:border-zinc-800 dark:bg-zinc-900/40">
          <SkeletonLine width="w-12" />
          <SkeletonLine width="mt-4 w-[76%]" />
          <SkeletonLine width="mt-2 w-[58%]" />
        </div>
      </div>
      <AssistantReplySkeleton />
    </div>
  );
}

function AssistantReplySkeleton({ compact = false }: { readonly compact?: boolean }): React.JSX.Element {
  return (
    <div className="flex items-start gap-4" aria-label="Companion is preparing a response">
      <SkeletonCircle />
      <div className="min-w-0 flex-1 pt-1">
        <SkeletonLine width="w-20" />
        <SkeletonLine width={`mt-4 ${compact ? 'w-[44%]' : 'w-[82%]'}`} />
        <SkeletonLine width={`mt-2 ${compact ? 'w-[28%]' : 'w-[64%]'}`} />
      </div>
    </div>
  );
}

function SkeletonCircle(): React.JSX.Element {
  return <span className="size-8 shrink-0 animate-pulse rounded-full bg-zinc-200 motion-reduce:animate-none dark:bg-zinc-800" />;
}

function SkeletonLine({ width }: { readonly width: string }): React.JSX.Element {
  return <span className={`block h-3 animate-pulse rounded bg-zinc-200 motion-reduce:animate-none dark:bg-zinc-800 ${width}`} />;
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
