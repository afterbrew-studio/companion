import { useEffect, useRef, useState } from 'react';
import {
  ErrorBar,
  InlineLoading,
  Markdown,
  SparkleIcon,
  Spinner,
  StatusDot,
} from '@moxxy/companion-sdk/ui';
import { AskSheet } from '@companion/module-operate/client';
import { PreparedActions } from '@companion/module-workbench/client';
import type { DeskMissionView } from '../../contract/index.js';
import { missionStatus } from '../status.js';
import { useMissionConversation } from '../hooks/useMissionConversation.js';

const SUGGESTIONS = [
  'Summarize the attached context and tell me what needs attention.',
  'Check the current state and propose the safest next action.',
  'Work on this in the background and stop only when you need my decision.',
] as const;

export function MissionChat({ view }: { readonly view: DeskMissionView | null }): React.JSX.Element {
  const conversation = useMissionConversation(view?.mission.id ?? null);
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const status = view ? missionStatus({ ...view, run: conversation.run ?? view.run }) : null;

  useEffect(() => {
    setInput('');
    inputRef.current?.focus();
  }, [view?.mission.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [conversation.items, conversation.asks, conversation.busy]);

  if (!view) {
    return (
      <main className="flex min-w-0 flex-1 items-center justify-center bg-white dark:bg-zinc-950">
        <div className="max-w-md px-6 text-center">
          <span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
            <SparkleIcon className="size-5" />
          </span>
          <h1 className="mt-4 text-xl font-semibold">Start a mission</h1>
          <p className="dim mt-2 text-sm leading-relaxed">
            Choose a workspace and repository, then create an independent task. Each mission keeps working when you switch to another one.
          </p>
        </div>
      </main>
    );
  }

  const submit = (): void => {
    const text = input.trim();
    if (!text || conversation.busy) return;
    setInput('');
    void conversation.send(text);
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-white dark:bg-zinc-950" aria-label="Mission conversation">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-zinc-200 px-5 dark:border-zinc-800">
        <span className="flex size-8 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
          <SparkleIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{view.mission.title}</h1>
          <div className="dim mt-0.5 flex items-center gap-1.5 text-[11px]">
            {status ? <StatusDot tone={status.tone} pulse={status.pulse} size="sm" label={status.label} /> : null}
            <span>{status?.label}</span>
            <span>·</span>
            <span className="truncate">{view.mission.repo ?? 'Whole workspace'}</span>
          </div>
        </div>
        {conversation.busy ? (
          <button type="button" className="btn-ghost h-8 text-xs" onClick={() => void conversation.abort()}>
            Stop turn
          </button>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="mx-auto flex min-h-full max-w-3xl flex-col justify-end">
          {conversation.loading ? (
            <InlineLoading />
          ) : conversation.items.length === 0 ? (
            <div className="my-auto py-10 text-center">
              <span className="mx-auto flex size-14 items-center justify-center rounded-2xl border border-zinc-200 bg-zinc-50 text-emerald-600 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-emerald-400">
                <SparkleIcon className="size-6" />
              </span>
              <h2 className="mt-5 text-xl font-semibold">What should I handle?</h2>
              <p className="dim mx-auto mt-2 max-w-lg text-sm leading-relaxed">
                Talk normally. I can inspect the selected PRs and issues, prepare changes, run work, and ask only when a decision is required.
              </p>
              <div className="mx-auto mt-5 flex max-w-xl flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    className="cursor-pointer rounded-full border border-zinc-200 px-3 py-1.5 text-xs text-zinc-600 transition-colors hover:border-emerald-500/50 hover:text-zinc-900 dark:border-zinc-700 dark:text-zinc-300 dark:hover:text-zinc-100"
                    onClick={() => void conversation.send(suggestion)}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {conversation.items.map((item, index) => item.kind === 'user' ? (
                <div
                  key={index}
                  className="anim-in ml-12 max-w-[82%] self-end rounded-2xl rounded-br-md bg-zinc-900 px-4 py-2.5 text-sm whitespace-pre-wrap text-white dark:bg-zinc-100 dark:text-zinc-900"
                >
                  {item.text}
                </div>
              ) : item.kind === 'assistant' ? (
                <div key={index} className="anim-in markdown max-w-none pr-8 text-sm leading-relaxed">
                  <Markdown text={item.text} />
                </div>
              ) : item.kind === 'tool' ? (
                <div key={index} className="anim-in dim flex items-center gap-2 text-[11px]" title={item.names.join(', ')}>
                  <span className="size-1.5 rounded-full bg-emerald-500" />
                  <span>
                    {item.names.length === 1 ? (
                      <>Used <span className="font-mono">{item.names[0]}</span></>
                    ) : (
                      <>{item.names.length} tool calls · <span className="font-mono">{[...new Set(item.names)].join(', ')}</span></>
                    )}
                  </span>
                </div>
              ) : (
                <div key={index} className={item.level === 'warn' ? 'text-sm text-amber-700 dark:text-amber-400' : 'error-bar'}>
                  {item.text}
                </div>
              ))}
            </div>
          )}
          {conversation.asks.map((ask) => (
            <AskSheet
              key={ask.requestId}
              ask={ask}
              onRespond={(response) => void conversation.respondAsk(ask.requestId, response)}
            />
          ))}
          <PreparedActions workspaceId={view.mission.workspaceId} compact />
          <ErrorBar error={conversation.error} className="mt-3" />
          <div ref={bottomRef} />
        </div>
      </div>

      <form
        className="shrink-0 border-t border-zinc-200 px-5 py-4 dark:border-zinc-800"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="mx-auto max-w-3xl rounded-2xl border border-zinc-300 bg-white px-3 pt-2 pb-2 shadow-sm transition-colors focus-within:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:focus-within:border-zinc-400">
          <textarea
            ref={inputRef}
            rows={2}
            className="max-h-40 min-h-12 w-full resize-none border-none bg-transparent px-1 py-1 text-sm outline-none placeholder:text-zinc-400"
            placeholder={conversation.busy ? 'This mission is working… switch to another mission to continue in parallel.' : 'Tell the agent what to do…'}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <div className="flex items-center gap-2">
            <span className="dim min-w-0 flex-1 truncate text-[11px]">
              {view.mission.contexts.length > 0
                ? `${view.mission.contexts.length} context ${view.mission.contexts.length === 1 ? 'item' : 'items'} attached`
                : 'Workspace and repository scope are always included'}
            </span>
            {conversation.busy ? (
              <span className="dim flex items-center gap-1.5 text-xs"><Spinner /> Working</span>
            ) : (
              <button type="submit" className="btn h-8 px-3 text-xs" disabled={!input.trim()}>
                Send
              </button>
            )}
          </div>
        </div>
      </form>
    </main>
  );
}
