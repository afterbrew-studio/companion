import { useCallback, useEffect, useRef, useState } from 'react';
import type { AskRequest, MoxxyEvent } from '@moxxy/companion-sdk/agents';
import { onServerMessage } from '@moxxy/companion-sdk/client';
import { ErrorBar, Markdown, Spinner } from '@moxxy/companion-sdk/ui';
import { AskSheet } from '@companion/module-operate/client';
import type { ReviewFinding } from '../../../contract/index.js';
import { codeApi as api } from '../../api.js';

type ChatItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; streaming: boolean }
  | { kind: 'tool'; names: string[] }
  | { kind: 'error'; text: string };

/** Consecutive tool calls fold into one line; the detail belongs in the run. */
function pushToolCall(items: ChatItem[], name: string): ChatItem[] {
  const last = items[items.length - 1];
  if (last?.kind === 'tool') return [...items.slice(0, -1), { kind: 'tool', names: [...last.names, name] }];
  return [...items, { kind: 'tool', names: [name] }];
}

/** Mirrors CHAT_MARKER on the server: everything before it is daemon context. */
const CHAT_MARKER = '<<<REVIEWER_MESSAGE>>>';
/** The server names the finding for the agent; the thread already shows which. */
const ABOUT_PREFIX = /^About finding "[^"]*"(?: \([^)]*\))?:\n\n/;

/** What the reviewer actually typed, with the briefing and header folded out. */
function visibleUserText(raw: string): string {
  const at = raw.indexOf(CHAT_MARKER);
  const said = at >= 0 ? raw.slice(at + CHAT_MARKER.length).trimStart() : raw;
  return said.replace(ABOUT_PREFIX, '').trim();
}

function foldEvents(events: readonly MoxxyEvent[]): ChatItem[] {
  let out: ChatItem[] = [];
  for (const event of events) {
    if (event.type === 'user_prompt') {
      const visible = visibleUserText((event as { text?: string }).text ?? '');
      if (visible) out.push({ kind: 'user', text: visible });
    } else if (event.type === 'assistant_message') {
      const content = (event as { content?: string }).content ?? '';
      if (content.trim()) out.push({ kind: 'assistant', text: content, streaming: false });
    } else if (event.type === 'tool_call_requested') {
      out = pushToolCall(out, (event as { name?: string }).name ?? 'tool');
    }
  }
  return out;
}

/**
 * A thread with the agent about one finding.
 *
 * The conversation itself is per REVIEW (one agent holding one checkout); this
 * panel scopes the question to a finding and shows the shared transcript. That
 * is why a thread opened on the second finding may already have history: it is
 * the same conversation, and that is usually what the reviewer wants.
 */
export function FindingChat({
  reviewId,
  finding,
  canChat,
}: {
  reviewId: string;
  finding: ReviewFinding;
  canChat: boolean;
}): React.JSX.Element {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [thinking, setThinking] = useState(false);
  const [asks, setAsks] = useState<AskRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    api
      .reviewChat(reviewId)
      .then(({ run, pendingAsks, history }) => {
        if (!alive) return;
        runIdRef.current = run?.id ?? null;
        setAsks(pendingAsks);
        setItems(foldEvents(history.events));
      })
      .catch((err) => alive && setError(String(err)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [reviewId]);

  useEffect(() => {
    return onServerMessage((msg) => {
      // An unanswered ask stalls the turn, so it has to surface here rather
      // than only on the run page the reviewer is not looking at.
      if (msg.t === 'ask' && msg.runId === runIdRef.current) {
        setThinking(false);
        setAsks((prev) => (prev.some((a) => a.requestId === msg.ask.requestId) ? prev : [...prev, msg.ask]));
        return;
      }
      if (msg.t === 'askResolved' && msg.runId === runIdRef.current) {
        setAsks((prev) => prev.filter((a) => a.requestId !== msg.requestId));
        return;
      }
      if (msg.t !== 'event' || msg.runId !== runIdRef.current) return;
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
        setThinking(false);
        setItems((prev) => {
          const last = prev[prev.length - 1];
          const base = last?.kind === 'assistant' && last.streaming ? prev.slice(0, -1) : prev;
          return content.trim() ? [...base, { kind: 'assistant', text: content, streaming: false }] : base;
        });
      } else if (event.type === 'tool_call_requested') {
        setItems((prev) => pushToolCall(prev, (event as { name?: string }).name ?? 'tool'));
      } else if (event.type === 'error') {
        const { message, kind } = event as { message?: string; kind?: string };
        // Only a fatal error ended the turn; moxxy retries overload itself.
        if (message && kind === 'fatal') {
          setThinking(false);
          setItems((prev) => [...prev, { kind: 'error', text: message }]);
        }
      }
    });
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'nearest' });
  }, [items]);

  const send = useCallback(async (): Promise<void> => {
    if (!canChat) return;
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    setError(null);
    setThinking(true);
    setItems((prev) => [...prev, { kind: 'user', text }]);
    try {
      const { runId } = await api.askReviewChat(reviewId, finding.id, text);
      runIdRef.current = runId;
    } catch (err) {
      setThinking(false);
      setError(String(err));
    }
  }, [canChat, draft, reviewId, finding.id]);

  return (
    <div className="mt-3 border-t border-zinc-200/80 pt-3 dark:border-zinc-800">
      {loading ? (
        <div className="dim flex items-center gap-2 text-xs">
          <Spinner /> Loading discussion…
        </div>
      ) : (
        <div className="flex max-h-72 flex-col gap-2 overflow-y-auto pr-1">
          {items.length === 0 ? (
            <p className="dim text-xs">
              Ask the agent about this finding. It still has the pull request checked out, so it can go and look.
            </p>
          ) : null}
          {items.map((item, i) =>
            item.kind === 'tool' ? (
              <p key={i} className="dim text-[11px]">
                read {item.names.length} {item.names.length === 1 ? 'thing' : 'things'} ({item.names.join(', ')})
              </p>
            ) : item.kind === 'error' ? (
              <ErrorBar key={i} error={item.text} />
            ) : (
              <div
                key={i}
                className={`rounded-lg px-3 py-2 text-[13px] ${
                  item.kind === 'user'
                    ? 'self-end bg-accent-500/10'
                    : 'border border-zinc-200 dark:border-zinc-800'
                }`}
              >
                <Markdown text={item.text} />
              </div>
            ),
          )}
          {canChat
            ? asks.map((ask) => (
                <AskSheet
                  key={ask.requestId}
                  ask={ask}
                  onRespond={(response) => {
                    setAsks((prev) => prev.filter((a) => a.requestId !== ask.requestId));
                    setThinking(true);
                    void api.answerReviewChatAsk(reviewId, ask.requestId, response).catch((err) => setError(String(err)));
                  }}
                />
              ))
            : asks.length > 0
              ? <p className="dim text-xs">The agent is waiting for a reviewer with run-control access.</p>
              : null}
          {thinking ? (
            <div className="dim flex items-center gap-2 text-xs">
              <Spinner /> Checking the code…
            </div>
          ) : null}
          <div ref={bottomRef} />
        </div>
      )}

      <ErrorBar error={error} />

      {canChat ? (
        <div className="mt-2 flex items-end gap-2">
          <textarea
            className="input min-h-9 flex-1 text-[13px]"
            placeholder="Is this really a problem? Why?"
            value={draft}
            rows={1}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button className="btn" disabled={!draft.trim() || thinking} onClick={() => void send()}>
            Ask
          </button>
        </div>
      ) : null}
    </div>
  );
}
