import { useCallback, useEffect, useRef, useState } from 'react';
import type { AskRequest, MoxxyEvent } from '@moxxy/companion-sdk/agents';
import { onServerMessage } from '@moxxy/companion-sdk/client';
import { USER_MARKER } from '@companion/module-automations/contract';
import type { RunRecord } from '@companion/module-operate/contract';
import { deskApi } from '../api.js';

export type MissionChatItem =
  | { readonly kind: 'user'; readonly text: string }
  | { readonly kind: 'assistant'; readonly text: string; readonly streaming: boolean }
  | { readonly kind: 'tool'; readonly names: readonly string[] }
  | { readonly kind: 'error'; readonly text: string; readonly level: 'error' | 'warn' };

export interface MissionConversation {
  readonly run: RunRecord | null;
  readonly items: readonly MissionChatItem[];
  readonly asks: readonly AskRequest[];
  readonly busy: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly send: (text: string) => Promise<void>;
  readonly abort: () => Promise<void>;
  readonly respondAsk: (requestId: string, response: Record<string, unknown>) => Promise<void>;
  readonly clearError: () => void;
}

function visibleUserText(text: string): string {
  const at = text.indexOf(USER_MARKER);
  return at >= 0 ? text.slice(at + USER_MARKER.length).trimStart() : text;
}

function pushToolCall(items: readonly MissionChatItem[], name: string): MissionChatItem[] {
  const last = items.at(-1);
  if (last?.kind === 'tool') {
    return [...items.slice(0, -1), { kind: 'tool', names: [...last.names, name] }];
  }
  return [...items, { kind: 'tool', names: [name] }];
}

function foldEvents(events: readonly MoxxyEvent[]): MissionChatItem[] {
  let items: MissionChatItem[] = [];
  for (const event of events) {
    if (event.type === 'user_prompt') {
      const text = visibleUserText((event as { readonly text?: string }).text ?? '');
      if (text) items.push({ kind: 'user', text });
    } else if (event.type === 'assistant_message') {
      const text = (event as { readonly content?: string }).content ?? '';
      if (text.trim()) items.push({ kind: 'assistant', text, streaming: false });
    } else if (event.type === 'tool_call_requested') {
      items = pushToolCall(items, (event as { readonly name?: string }).name ?? 'tool');
    } else if (event.type === 'error') {
      const detail = event as { readonly message?: string; readonly kind?: string };
      if (detail.message) {
        items.push({
          kind: 'error',
          text: detail.message,
          level: detail.kind === 'fatal' ? 'error' : 'warn',
        });
      }
    }
  }
  return items;
}

function isWorking(run: RunRecord | null): boolean {
  return run?.status === 'queued' || run?.status === 'provisioning' || run?.status === 'running';
}

/** One attended conversation controller. Its run-id ref switches atomically
 * with the selected mission, so streams from another tab never leak in. */
export function useMissionConversation(missionId: string | null): MissionConversation {
  const [run, setRun] = useState<RunRecord | null>(null);
  const [items, setItems] = useState<MissionChatItem[]>([]);
  const [asks, setAsks] = useState<AskRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(missionId !== null);
  const [error, setError] = useState<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  const missionIdRef = useRef<string | null>(missionId);
  missionIdRef.current = missionId;

  useEffect(() => {
    let alive = true;
    runIdRef.current = null;
    setRun(null);
    setItems([]);
    setAsks([]);
    setBusy(false);
    setError(null);
    setLoading(missionId !== null);
    if (!missionId) return () => { alive = false; };

    void (async () => {
      try {
        const view = await deskApi.mission(missionId);
        if (!alive) return;
        setRun(view.run);
        setAsks([...view.pendingAsks]);
        setBusy(isWorking(view.run));
        runIdRef.current = view.run?.id ?? null;
        if (view.run) {
          const history = await deskApi.history(missionId, null);
          if (alive) setItems(foldEvents(history.events));
        }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [missionId]);

  useEffect(() => onServerMessage((message) => {
    const runId = runIdRef.current;
    if (!runId) return;
    if (message.t === 'event' && message.runId === runId) {
      const event = message.event;
      if (event.type === 'assistant_chunk') {
        const delta = (event as { readonly delta?: string }).delta ?? '';
        setItems((previous) => {
          const last = previous.at(-1);
          if (last?.kind === 'assistant' && last.streaming) {
            return [...previous.slice(0, -1), { ...last, text: last.text + delta }];
          }
          return [...previous, { kind: 'assistant', text: delta, streaming: true }];
        });
      } else if (event.type === 'assistant_message') {
        const text = (event as { readonly content?: string }).content ?? '';
        setItems((previous) => {
          const last = previous.at(-1);
          const withoutStream = last?.kind === 'assistant' && last.streaming
            ? previous.slice(0, -1)
            : previous;
          return text.trim()
            ? [...withoutStream, { kind: 'assistant', text, streaming: false }]
            : withoutStream;
        });
      } else if (event.type === 'tool_call_requested') {
        setItems((previous) => pushToolCall(previous, (event as { readonly name?: string }).name ?? 'tool'));
      } else if (event.type === 'error') {
        const detail = event as { readonly message?: string; readonly kind?: string };
        if (detail.message) {
          setItems((previous) => [...previous, {
            kind: 'error',
            text: detail.message!,
            level: detail.kind === 'fatal' ? 'error' : 'warn',
          }]);
        }
      }
    } else if (message.t === 'turn' && message.runId === runId) {
      setBusy(message.phase === 'started');
    } else if (message.t === 'ask' && message.runId === runId) {
      setAsks((previous) => previous.some((ask) => ask.requestId === message.ask.requestId)
        ? previous
        : [...previous, message.ask]);
    } else if (message.t === 'askResolved' && message.runId === runId) {
      setAsks((previous) => previous.filter((ask) => ask.requestId !== message.requestId));
    } else if (message.t === 'run.changed' && message.run.id === runId) {
      setRun(message.run);
      setBusy(isWorking(message.run));
    }
  }), []);

  const send = useCallback(async (text: string): Promise<void> => {
    const trimmed = text.trim();
    if (!missionId || !trimmed || busy) return;
    const targetMissionId = missionId;
    setError(null);
    setBusy(true);
    setItems((previous) => [...previous, { kind: 'user', text: trimmed }]);
    try {
      if (!runIdRef.current) {
        const view = await deskApi.ensureSession(targetMissionId);
        if (missionIdRef.current === targetMissionId) {
          runIdRef.current = view.run?.id ?? null;
          setRun(view.run);
          setAsks([...view.pendingAsks]);
        }
      }
      await deskApi.sendMessage(targetMissionId, trimmed);
    } catch (err) {
      if (missionIdRef.current === targetMissionId) {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      }
    }
  }, [busy, missionId]);

  const abort = useCallback(async (): Promise<void> => {
    if (!missionId) return;
    const targetMissionId = missionId;
    try {
      await deskApi.abort(targetMissionId);
    } catch {
      // The turn may have completed between the click and the request.
    }
  }, [missionId]);

  const respondAsk = useCallback(async (
    requestId: string,
    response: Record<string, unknown>,
  ): Promise<void> => {
    if (!missionId) return;
    const targetMissionId = missionId;
    setError(null);
    try {
      await deskApi.respondAsk(targetMissionId, requestId, response);
    } catch (err) {
      if (missionIdRef.current === targetMissionId) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }, [missionId]);

  return {
    run,
    items,
    asks,
    busy,
    loading,
    error,
    send,
    abort,
    respondAsk,
    clearError: () => setError(null),
  };
}
