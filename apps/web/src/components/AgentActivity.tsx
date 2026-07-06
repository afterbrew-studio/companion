import { useEffect, useRef, useState } from 'react';
import type { MoxxyEvent, RunRecord } from '@companion/contract';
import { api, onServerMessage } from '../lib/api.js';
import { timeAgo } from './ui.js';

/**
 * Live timeline of the agent working on THIS entity (issue/PR). Finds the
 * newest live run matching the filter, seeds from its history, then streams
 * events over the app socket. Renders the last few steps with a pulse while
 * the agent is thinking.
 */

interface TimelineEntry {
  readonly id: string;
  readonly icon: string;
  readonly label: string;
  readonly tone: 'ok' | 'err' | 'info';
  readonly ts: number;
}

const MAX_ENTRIES = 7;

export function AgentActivity({
  repo,
  issueNumber,
}: {
  repo: string;
  issueNumber: number;
}): JSX.Element | null {
  const [run, setRun] = useState<RunRecord | null>(null);
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const toolNames = useRef(new Map<string, string>());
  const matches = (r: RunRecord): boolean =>
    r.repo === repo && r.issueNumber === issueNumber && r.kind !== 'interactive';

  useEffect(() => {
    let alive = true;
    api
      .listRuns()
      .then(({ runs }) => {
        if (!alive) return;
        const live = runs.find((r) => r.live && matches(r));
        if (live) setRun(live);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, issueNumber]);

  // Seed the timeline from the run's recent history once we know the run.
  useEffect(() => {
    if (!run) return;
    let alive = true;
    api
      .history(run.id, null, 40)
      .then((segment) => {
        if (!alive) return;
        const seeded: TimelineEntry[] = [];
        for (const event of segment.events) {
          const entry = toEntry(event, toolNames.current);
          if (entry) seeded.push(entry);
        }
        setEntries(seeded.slice(-MAX_ENTRIES));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [run?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return onServerMessage((msg) => {
      if (msg.t === 'run.changed' && matches(msg.run)) {
        setRun((prev) => (msg.run.live ? msg.run : prev && prev.id === msg.run.id ? msg.run : prev));
      }
      if (msg.t === 'event' && run && msg.runId === run.id) {
        const entry = toEntry(msg.event, toolNames.current);
        if (entry) setEntries((prev) => [...prev, entry].slice(-MAX_ENTRIES));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id, repo, issueNumber]);

  if (!run) return null;
  const working = run.live && (run.status === 'running' || run.status === 'provisioning');

  return (
    <section
      className="anim-in card mt-4 border-accent-400/50 dark:border-accent-500/40"
      aria-label="Agent activity"
      aria-live="polite"
    >
      <div className="flex items-center gap-2.5">
        {working ? (
          <span className="relative flex size-2.5" aria-hidden>
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent-500 opacity-60 motion-reduce:hidden" />
            <span className="relative inline-flex size-2.5 rounded-full bg-accent-500" />
          </span>
        ) : (
          <span className="inline-flex size-2.5 rounded-full bg-zinc-400" aria-hidden />
        )}
        <strong className="text-sm">{working ? 'Agent working' : 'Agent activity'}</strong>
        <span className="dim min-w-0 flex-1 truncate">{run.title}</span>
        <a className="linkish text-sm" href={`#/runs/${run.id}`}>
          open run →
        </a>
      </div>
      <ol className="mt-2.5 flex flex-col gap-1" aria-label="Latest agent events">
        {entries.map((e, i) => (
          <li
            key={e.id}
            className={`anim-in flex items-center gap-2 text-[13px] ${
              i === entries.length - 1 ? '' : 'opacity-70'
            }`}
          >
            <span
              className={
                e.tone === 'err'
                  ? 'text-red-500'
                  : e.tone === 'ok'
                    ? 'text-emerald-500'
                    : 'text-accent-400'
              }
              aria-hidden
            >
              {e.icon}
            </span>
            <span className="min-w-0 flex-1 truncate">{e.label}</span>
            <span className="dim text-xs">{timeAgo(e.ts)}</span>
          </li>
        ))}
        {entries.length === 0 ? <li className="dim text-[13px]">Waiting for the first event…</li> : null}
      </ol>
    </section>
  );
}

function toEntry(event: MoxxyEvent, toolNames: Map<string, string>): TimelineEntry | null {
  const e = event as MoxxyEvent & {
    id?: string;
    ts?: number;
    name?: string;
    callId?: string;
    ok?: boolean;
    model?: string;
    reason?: string;
    message?: string;
    content?: string;
  };
  const base = { id: e.id ?? `${e.type}-${e.ts ?? Math.random()}`, ts: e.ts ?? Date.now() };
  switch (e.type) {
    case 'user_prompt':
      return { ...base, icon: '▸', label: 'Prompt sent', tone: 'info' };
    case 'provider_request':
      return { ...base, icon: '◌', label: `Thinking — ${e.model ?? 'model'}`, tone: 'info' };
    case 'tool_call_requested':
      if (e.callId && e.name) toolNames.set(e.callId, e.name);
      return { ...base, icon: '⚙', label: `Running ${e.name ?? 'tool'}`, tone: 'info' };
    case 'tool_result': {
      const name = (e.callId && toolNames.get(e.callId)) ?? 'tool';
      return e.ok === false
        ? { ...base, icon: '✕', label: `${name} failed`, tone: 'err' }
        : { ...base, icon: '✓', label: `${name} finished`, tone: 'ok' };
    }
    case 'assistant_message':
      return {
        ...base,
        icon: '✎',
        label: e.content ? `Responded: ${e.content.slice(0, 80)}` : 'Responded',
        tone: 'ok',
      };
    case 'error':
      return { ...base, icon: '✕', label: e.message?.slice(0, 100) ?? 'Error', tone: 'err' };
    case 'abort':
      return { ...base, icon: '⏹', label: `Aborted — ${e.reason ?? 'unknown reason'}`, tone: 'err' };
    default:
      return null;
  }
}
