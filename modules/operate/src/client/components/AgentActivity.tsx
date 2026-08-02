import { useEffect, useRef, useState } from 'react';
import type { MoxxyEvent } from '@moxxy/companion-types';
import { onServerMessage } from '@moxxy/companion-core/client';
import { OutcomeDot, StatusDot, timeAgo } from '@moxxy/companion-ui';
import type { RunListRecord } from '../../contract/index.js';
import { operateApi as api } from '../api.js';

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
  readonly tone: 'ok' | 'err' | 'warn' | 'info';
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
  const [run, setRun] = useState<RunListRecord | null>(null);
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const toolNames = useRef(new Map<string, string>());
  const matches = (r: RunListRecord): boolean =>
    r.repo === repo && r.issueNumber === issueNumber && r.kind !== 'interactive';

  useEffect(() => {
    let alive = true;
    api
      .listRunsPage({ repo, status: 'active', limit: 100 })
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
          <StatusDot tone="zinc" size="lg" />
        )}
        <strong className="text-sm">{working ? 'Agent working' : 'Agent activity'}</strong>
        <span className="dim min-w-0 flex-1 truncate">{run.title}</span>
        <a className="linkish text-sm" href={`#/runs/${run.id}`}>
          open run →
        </a>
      </div>
      <ol className="mt-3 flex flex-col" aria-label="Latest agent events">
        {entries.length === 0 ? (
          <li className="dim text-[13px]">Waiting for the first event…</li>
        ) : (
          entries.map((e, i) => {
            const last = i === entries.length - 1;
            const active = last && working;
            const time = timeAgo(e.ts);
            const prev = entries[i - 1];
            const showTime = !prev || timeAgo(prev.ts) !== time;
            return (
              <li key={e.id} className="anim-in relative flex gap-3 pb-3 last:pb-0">
                {/* connecting rail */}
                {!last && (
                  <span
                    className="absolute bottom-0 left-[6.5px] top-3 w-px bg-zinc-200 dark:bg-zinc-700/80"
                    aria-hidden
                  />
                )}
                {/* node */}
                <span className="relative z-10 mt-1 flex size-3.5 shrink-0 items-center justify-center" aria-hidden>
                  {active ? (
                    <span className="absolute inline-flex size-3.5 animate-ping rounded-full bg-accent-500/50 motion-reduce:hidden" />
                  ) : null}
                  {e.tone === 'err' ? (
                    <OutcomeDot ok={false} />
                  ) : e.tone === 'ok' ? (
                    <OutcomeDot ok />
                  ) : e.tone === 'warn' ? (
                    <StatusDot tone="amber" size="lg" />
                  ) : (
                    <span
                      className={`size-2 rounded-full ${
                        active
                          ? 'bg-accent-500'
                          : 'bg-zinc-300 ring-1 ring-inset ring-zinc-400/40 dark:bg-zinc-600 dark:ring-zinc-500/40'
                      }`}
                    />
                  )}
                </span>
                {/* label + time */}
                <div className="flex min-w-0 flex-1 items-baseline gap-2 pt-0.5">
                  <span
                    className={`min-w-0 flex-1 truncate text-[13px] ${
                      last ? 'text-zinc-800 dark:text-zinc-100' : 'text-zinc-500 dark:text-zinc-400'
                    }`}
                  >
                    {e.label}
                  </span>
                  {showTime ? <span className="dim shrink-0 text-[11px] tabular-nums">{time}</span> : null}
                </div>
              </li>
            );
          })
        )}
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
    kind?: string;
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
    case 'error': {
      // Same rule as the transcript fold: only 'fatal' ended the run. moxxy's
      // own retries surface here as 'retryable' while it is still working.
      const fatal = e.kind === 'fatal';
      return {
        ...base,
        icon: fatal ? '✕' : '⚠',
        label: e.message?.slice(0, 100) ?? 'Error',
        tone: fatal ? 'err' : 'warn',
      };
    }
    case 'abort':
      return { ...base, icon: '⏹', label: `Aborted: ${e.reason ?? 'unknown reason'}`, tone: 'err' };
    default:
      return null;
  }
}
