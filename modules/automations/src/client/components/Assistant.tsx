import { useCallback, useEffect, useRef, useState } from 'react';
import type { AskRequest, MoxxyEvent } from '@moxxy/companion-sdk/agents';
import { onServerMessage } from '@moxxy/companion-sdk/client';
import { CloseIcon, ErrorBar, IconButton, InlineLoading, Markdown, SparkleIcon, Spinner, aiAccentClass } from '@moxxy/companion-sdk/ui';
import type { RepoRecord } from '@companion/module-code/contract';
import { codeApi } from '@companion/module-code/client';
import type { RunRecord } from '@companion/module-operate/contract';
import { AskSheet } from '@companion/module-operate/client';
import { useWorkspace } from '@companion/module-workspace/client';
import { automationsApi as api } from '../api.js';

/**
 * AI Help: a platform-wide assistant that knows Companion inside out and acts
 * on the user's behalf through the same REST API the SPA uses (scoped to the
 * user's own role). One conversation run per user; the daemon briefs the agent
 * on first contact — the briefing is folded out of the visible transcript.
 */

/** The daemon prefixes the first prompt with the platform briefing up to this marker. */
const USER_MARKER = '<<<USER_MESSAGE>>>';

function visibleUserText(text: string): string {
  const at = text.indexOf(USER_MARKER);
  return at >= 0 ? text.slice(at + USER_MARKER.length).trimStart() : text;
}

type ChatItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; streaming: boolean }
  /** Consecutive tool calls fold into one entry. */
  | { kind: 'tool'; names: string[] }
  | { kind: 'error'; text: string; level: 'error' | 'warn' };

/** Append a tool call, folding into the previous entry when it is also tools. */
function pushToolCall(items: ChatItem[], name: string): ChatItem[] {
  const last = items[items.length - 1];
  if (last?.kind === 'tool') return [...items.slice(0, -1), { kind: 'tool', names: [...last.names, name] }];
  return [...items, { kind: 'tool', names: [name] }];
}

const SUGGESTIONS = [
  'What can you do for me?',
  'What is waiting on my review right now?',
  'Summarize the open pull requests in this workspace.',
];

/**
 * The assistant's mascot: a hovering robo-puppy that floats over its shadow,
 * wags its tail, blinks, glances around, twitches an ear, and keeps its chest
 * light pulsing — pure CSS keyframes, stilled for reduced-motion.
 */
function RobotPet(): JSX.Element {
  return (
    <div className="flex justify-center pt-3 pb-1" aria-hidden>
      <svg viewBox="0 0 120 120" fill="none" className="ai-pet h-auto w-1/2 max-w-[13rem] text-zinc-400 dark:text-zinc-500">
        {/* ground shadow — breathes opposite the hover */}
        <ellipse className="ai-pet-shadow" cx="60" cy="110" rx="24" ry="4" fill="currentColor" opacity="0.18" />

        <g className="ai-pet-float">
          {/* perky ears — the right one twitches now and then */}
          <path d="M38 25 L33 9 L50 17" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          <g className="ai-pet-ear">
            <path d="M82 25 L87 9 L70 17" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </g>

          {/* head + face screen */}
          <rect x="30" y="24" width="60" height="42" rx="14" stroke="currentColor" strokeWidth="2.5" />
          <rect x="38" y="31" width="44" height="28" rx="9" fill="rgb(16 185 129 / 0.09)" />

          {/* face — the gaze group glances left and right */}
          <g className="ai-pet-gaze">
            <circle className="ai-pet-eye" cx="50" cy="43" r="4.5" fill="rgb(16 185 129)" />
            <circle className="ai-pet-eye" cx="70" cy="43" r="4.5" fill="rgb(16 185 129)" />
            <circle cx="60" cy="50" r="2.2" fill="currentColor" />
            {/* puppy mouth */}
            <path d="M53 54.5q3.5 4 7 0 3.5 4 7 0" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" fill="none" />
          </g>

          {/* neck + hovering body (no legs — it floats) */}
          <path d="M60 66v5" stroke="currentColor" strokeWidth="2.5" />
          <rect x="40" y="71" width="40" height="26" rx="11" stroke="currentColor" strokeWidth="2.5" />
          <circle className="ai-pet-heart" cx="60" cy="84" r="4.5" fill="rgb(16 185 129 / 0.85)" />

          {/* front paws hanging in the hover */}
          <path d="M50 97v5M70 97v5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />

          {/* the tail never stops wagging */}
          <g className="ai-pet-wag">
            <path d="M80 86q10 2 13.5-6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            <circle cx="94.5" cy="78.5" r="2.6" fill="currentColor" />
          </g>
        </g>
      </svg>
    </div>
  );
}

export function AssistantButton({ onClick, open }: { onClick: () => void; open: boolean }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="AI Help — ask the Companion assistant"
      aria-expanded={open}
      title="AI Help"
      className={`ai-glow flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border transition-colors ${aiAccentClass(open)}`}
    >
      <SparkleIcon className="size-4.5" />
    </button>
  );
}

export function AssistantPanel({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
  const { current } = useWorkspace();
  const [run, setRun] = useState<RunRecord | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [asks, setAsks] = useState<AskRequest[]>([]);
  const [input, setInput] = useState('');
  const [repos, setRepos] = useState<RepoRecord[]>([]);
  /** Repo the conversation focuses on; '' = the whole workspace. */
  const [scope, setScope] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const foldEvents = useCallback((events: readonly MoxxyEvent[]): ChatItem[] => {
    let out: ChatItem[] = [];
    for (const event of events) {
      if (event.type === 'user_prompt') {
        const text = visibleUserText((event as { text?: string }).text ?? '');
        if (text) out.push({ kind: 'user', text });
      } else if (event.type === 'assistant_message') {
        const content = (event as { content?: string }).content ?? '';
        if (content.trim()) out.push({ kind: 'assistant', text: content, streaming: false });
      } else if (event.type === 'tool_call_requested') {
        out = pushToolCall(out, (event as { name?: string }).name ?? 'tool');
      }
    }
    return out;
  }, []);

  // Repo choices for the scope select follow the active workspace.
  useEffect(() => {
    if (!current) return;
    let alive = true;
    codeApi
      .workspaceRepos(current.id)
      .then(({ repos }) => alive && setRepos(repos))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [current]);

  // Attach to the existing conversation (if any) on open.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { run, pendingAsks } = await api.assistant();
        if (!alive) return;
        setRun(run);
        setAsks(pendingAsks);
        runIdRef.current = run?.id ?? null;
        if (run) {
          const segment = await api.assistantHistory(null);
          if (!alive) return;
          setItems(foldEvents(segment.events));
        }
      } catch (err) {
        if (alive) setError(String(err));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [foldEvents]);

  // Live stream: chunks, messages, tool calls, turn state, asks.
  useEffect(() => {
    return onServerMessage((msg) => {
      const runId = runIdRef.current;
      if (msg.t === 'event' && msg.runId === runId) {
        const event = msg.event;
        if (event.type === 'assistant_chunk') {
          const delta = (event as { delta?: string }).delta ?? '';
          setItems((prev) => {
            const last = prev[prev.length - 1];
            if (last?.kind === 'assistant' && last.streaming) {
              return [...prev.slice(0, -1), { ...last, text: last.text + delta }];
            }
            return [...prev, { kind: 'assistant', text: delta, streaming: true }];
          });
        } else if (event.type === 'assistant_message') {
          const content = (event as { content?: string }).content ?? '';
          setItems((prev) => {
            const withoutStream = prev[prev.length - 1]?.kind === 'assistant' && (prev[prev.length - 1] as { streaming?: boolean }).streaming ? prev.slice(0, -1) : prev;
            return content.trim() ? [...withoutStream, { kind: 'assistant', text: content, streaming: false }] : withoutStream;
          });
        } else if (event.type === 'tool_call_requested') {
          const name = (event as { name?: string }).name ?? 'tool';
          setItems((prev) => pushToolCall(prev, name));
        } else if (event.type === 'error') {
          // Only 'fatal' ended the turn; moxxy rides out provider overload and
          // rate limits itself and reports those attempts as 'retryable' while
          // the agent is still working (same rule as the run transcript).
          const { message, kind } = event as { message?: string; kind?: string };
          if (message) {
            setItems((prev) => [...prev, { kind: 'error', text: message, level: kind === 'fatal' ? 'error' : 'warn' }]);
          }
        }
      } else if (msg.t === 'turn' && msg.runId === runId) {
        setBusy(msg.phase === 'started');
      } else if (msg.t === 'ask' && msg.runId === runId) {
        setAsks((prev) => (prev.some((a) => a.requestId === msg.ask.requestId) ? prev : [...prev, msg.ask]));
      } else if (msg.t === 'askResolved' && msg.runId === runId) {
        setAsks((prev) => prev.filter((a) => a.requestId !== msg.requestId));
      }
    });
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [items, asks, busy, open]);

  // While open: Esc closes, and the input takes focus for rapid back-and-forth.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    inputRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const send = async (text: string): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setInput('');
    setError(null);
    setBusy(true);
    setItems((prev) => [...prev, { kind: 'user', text: trimmed }]);
    try {
      // Know the run id BEFORE prompting so no stream event slips past the
      // WS filter; the daemon reuses (or resumes) the conversation run.
      if (!runIdRef.current) {
        const { run } = await api.assistantSession();
        runIdRef.current = run.id;
        setRun(run);
      }
      await api.assistantMessage(trimmed, scope || undefined);
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  const reset = async (): Promise<void> => {
    try {
      await api.assistantReset();
      setRun(null);
      runIdRef.current = null;
      setItems([]);
      setAsks([]);
      setBusy(false);
      setError(null);
      inputRef.current?.focus();
    } catch (err) {
      setError(String(err));
    }
  };

  const abort = async (): Promise<void> => {
    try {
      await api.assistantAbort();
    } catch {
      // the turn may have just finished — harmless
    }
  };

  return (
    // This contribution is mounted inside the top-bar slot, so it must leave
    // that flex row before taking its width. Keeping the drawer fixed to the
    // viewport's right edge also gives desktop and mobile the same direction.
    // `visibility` rides the slide so a closed panel leaves the tab order.
    <aside
      className={`fixed inset-y-0 right-0 z-50 flex w-full shrink-0 flex-col overflow-hidden bg-white shadow-2xl transition-[transform,visibility] duration-200 ease-in-out motion-reduce:transition-none sm:w-[26rem] dark:bg-zinc-950 ${
        open
          ? 'visible translate-x-0 border-l border-zinc-200 dark:border-zinc-800'
          : 'invisible translate-x-full'
      }`}
      role="complementary"
      aria-label="AI Help"
      aria-hidden={!open}
    >
      <div className="flex h-full w-full min-w-0 flex-col md:w-[26rem]">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-zinc-200 px-3.5 dark:border-zinc-800">
          <span className="flex size-6 items-center justify-center rounded-md bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" aria-hidden>
            <SparkleIcon className="size-3.5" />
          </span>
          <div className="min-w-0 flex-1 text-[13px] font-semibold">AI Help</div>
          {run ? (
            <IconButton label="New chat" onClick={() => void reset()}>
              <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden>
                <path
                  d="M8 2.5H4A1.5 1.5 0 0 0 2.5 4v8A1.5 1.5 0 0 0 4 13.5h8A1.5 1.5 0 0 0 13.5 12V8M12.9 2.4a1.4 1.4 0 0 1 2 2L9.5 9.8l-2.7.7.7-2.7 5.4-5.4z"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </IconButton>
          ) : null}
          <IconButton label="Close AI Help" onClick={onClose}>
            <CloseIcon className="size-3.5" />
          </IconButton>
        </div>

        {/* Chat anchors at the bottom (flex spacer above) and grows upward — a
            sent message pushes the earlier content up instead of hanging in the
            middle of an empty pane. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
          <div className="flex min-h-full flex-col justify-end">
            {loading ? (
              <InlineLoading />
            ) : items.length === 0 ? (
              <div className="flex flex-col gap-4">
                <RobotPet />
                <div className="text-center">
                  <h2 className="text-lg font-semibold">Hey there!</h2>
                  <p className="dim mx-auto mt-1 max-w-64 text-[13px] leading-relaxed">
                    Ask me anything about your workspace — or tell me what to do, and I'll do it.
                  </p>
                </div>
                <div className="flex flex-col items-center gap-1.5">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      className="cursor-pointer rounded-full border border-zinc-200 px-3 py-1.5 text-center text-xs text-zinc-600 transition-colors hover:border-emerald-500/50 hover:text-zinc-900 dark:border-zinc-700 dark:text-zinc-300 dark:hover:text-zinc-100"
                      onClick={() => void send(s)}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2.5">
                {items.map((item, i) =>
                  item.kind === 'user' ? (
                    <div key={i} className="anim-in ml-8 self-end rounded-xl rounded-br-sm bg-zinc-900 px-3 py-2 text-[13px] whitespace-pre-wrap text-white dark:bg-zinc-100 dark:text-zinc-900">
                      {item.text}
                    </div>
                  ) : item.kind === 'assistant' ? (
                    <div key={i} className="anim-in markdown mr-4 text-[13px]">
                      <Markdown text={item.text} />
                    </div>
                  ) : item.kind === 'tool' ? (
                    <div
                      key={i}
                      className="anim-in dim flex items-center gap-1.5 text-[11px]"
                      title={item.names.join(', ')}
                    >
                      <svg viewBox="0 0 16 16" fill="none" className="size-3" aria-hidden>
                        <path d="M9.5 3.5a3 3 0 0 0-4 4l-3 3 2.5 2.5 3-3a3 3 0 0 0 4-4l-2 2-1.5-1.5 2-2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                      </svg>
                      <span>
                        {item.names.length === 1 ? (
                          <span className="font-mono">{item.names[0]}</span>
                        ) : (
                          <>
                            {item.names.length} tool calls ·{' '}
                            <span className="font-mono">{[...new Set(item.names)].join(', ')}</span>
                          </>
                        )}
                      </span>
                    </div>
                  ) : (
                    <div
                      key={i}
                      className={item.level === 'warn' ? 'py-1.5 text-[13px] text-amber-700 dark:text-amber-400' : 'error-bar'}
                    >
                      {item.text}
                    </div>
                  ),
                )}
              </div>
            )}
            {asks.map((ask) => (
              <AskSheet key={ask.requestId} ask={ask} onRespond={(response) => void api.assistantAsk(ask.requestId, response).catch((err) => setError(String(err)))} />
            ))}
            <ErrorBar error={error} className="mt-2" />
            <div ref={bottomRef} />
          </div>
        </div>

        <form
          className="shrink-0 border-t border-zinc-200 p-3 dark:border-zinc-800"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          {/* One .input-shaped shell: textarea on top; repo scope, busy state,
              and the bare send icon share the row below. */}
          <div className="flex flex-col rounded-lg border border-zinc-300 bg-white px-2 pt-1 pb-1 transition-colors focus-within:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:focus-within:border-zinc-400">
            <textarea
              ref={inputRef}
              className="max-h-40 min-w-0 resize-none border-none bg-transparent px-1 py-1.5 text-[13px] text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100"
              rows={1}
              value={input}
              placeholder={busy ? 'Working…' : 'Ask, or tell me what to do…'}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
            />
            <div className="flex items-center gap-1.5">
              <select
                className="dim max-w-44 cursor-pointer truncate rounded-md bg-transparent py-1 text-xs outline-none transition-colors hover:text-zinc-800 dark:hover:text-zinc-200"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                aria-label="Repository scope for this conversation"
                title="Which repo should the assistant focus on?"
              >
                <option value="">All repositories</option>
                {repos.map((r) => (
                  <option key={r.fullName} value={r.fullName}>
                    {r.fullName.split('/')[1] ?? r.fullName}
                  </option>
                ))}
              </select>
              {busy ? (
                <span className="flex size-6 items-center justify-center" aria-label="The assistant is working" role="status">
                  <Spinner />
                </span>
              ) : null}
              <span className="flex-1" />
              {busy ? (
                <button
                  type="button"
                  className="dim flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors hover:text-zinc-800 dark:hover:text-zinc-200"
                  onClick={() => void abort()}
                  aria-label="Stop the current turn"
                  title="Stop"
                >
                  <svg viewBox="0 0 16 16" fill="none" className="size-3.5" aria-hidden>
                    <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
                  </svg>
                </button>
              ) : (
                <button
                  className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-emerald-600 transition-colors hover:text-emerald-500 disabled:cursor-default disabled:opacity-35 dark:text-emerald-400 dark:hover:text-emerald-300"
                  type="submit"
                  disabled={!input.trim()}
                  aria-label="Send message"
                  title="Send"
                >
                  <svg viewBox="0 0 16 16" fill="none" className="size-4.5" aria-hidden>
                    <path
                      d="M14 2 7.5 8.5M14 2 9.8 13.7a.4.4 0 0 1-.75.02L7.5 8.5 2.28 6.95a.4.4 0 0 1 .02-.75L14 2z"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </form>
      </div>
    </aside>
  );
}
