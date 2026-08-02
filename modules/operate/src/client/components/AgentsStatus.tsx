import { useEffect, useRef, useState } from 'react';
import { StatusDot as Dot } from '@moxxy/companion-ui';
import { isMessage, onServerMessage, onWsState, type WsState } from '@moxxy/companion-core/client';
import { useLane } from '../hooks/useLane.js';
import { useAuth } from '@companion/module-core/client';
import type { MoxxyStatus } from '../../contract/index.js';
import { operateApi } from '../api.js';

/**
 * One dot summarizing moxxy + GitHub + event stream: green when everything is
 * healthy, amber when partially degraded, red when the daemon is unreachable.
 * Hover or focus expands the popover with the individual statuses.
 */
export function AgentsStatus(): JSX.Element | null {
  // Contributed to the shell's top bar. It renders only while operate is
  // enabled, so the /api/moxxy/status 503 the shell-side version had to
  // special-case (to avoid a red "daemon unreachable" dot) cannot happen.
  const { user } = useAuth();
  const me = user?.username ?? null;
  const [status, setStatus] = useState<MoxxyStatus | null>(null);
  const [ws, setWs] = useState<WsState>('offline');
  const [liveIds, setLiveIds] = useState<ReadonlySet<string>>(new Set());

  // The pill counts the viewer's OWN sessions plus unattributed automation
  // (board workers, pipelines, scheduled jobs run with userId null) — the
  // server already scopes both listRuns and run.changed to what the viewer may
  // see. Colleagues' self-triggered runs carry THEIR username and stay off the
  // pill, visible on #/runs only.
  useEffect(() => {
    setLiveIds(new Set());
    if (!me) return;
    const mineOrAutomation = (userId: string | null): boolean => userId === null || userId === me;
    let alive = true;
    operateApi
      .listRunsPage({ status: 'active', limit: 100 })
      .then(({ runs }) => {
        if (alive) setLiveIds(new Set(runs.filter((r) => r.live && mineOrAutomation(r.userId)).map((r) => r.id)));
      })
      .catch(() => undefined); // roles without runs:read just see the count stay 0
    const off = onServerMessage((msg) => {
      if (msg.t !== 'run.changed' || !mineOrAutomation(msg.run.userId)) return;
      setLiveIds((prev) => {
        const next = new Set(prev);
        if (msg.run.live) next.add(msg.run.id);
        else next.delete(msg.run.id);
        return next;
      });
    });
    return () => {
      alive = false;
      off();
    };
  }, [me]);

  useEffect(() => {
    let alive = true;
    const load = (): void => {
      operateApi
        .status()
        .then((s) => alive && setStatus(s))
        .catch(() => alive && setStatus(null));
    };
    load();
    const timer = window.setInterval(load, 60_000);
    const offWs = onWsState(setWs);
    // Soft reaction to module-code: connecting a repo should turn the GitHub dot
    // green without waiting for the 60s poll. operate does not depend on code, so
    // the tag is not in its union; with code absent this simply never fires.
    const offMsg = onServerMessage((msg) => {
      if (isMessage(msg, 'repos.changed')) load();
    });
    return () => {
      alive = false;
      window.clearInterval(timer);
      offWs();
      offMsg();
    };
  }, []);


  const { lane } = useLane();

  const moxxyOk = Boolean(status && status.cliPath && status.compatible && status.homeReady);
  // Named for what it is rather than for one implementation of it: a machine
  // may run Claude Code or Codex, and calling the row "moxxy" made a healthy
  // instance look misconfigured to anyone not using it.
  const moxxyTitle = !status
    ? 'Runtime: status unknown'
    : !status.cliPath
      ? 'moxxy CLI not found'
      : !status.compatible
        ? `moxxy ${status.cliVersion ?? '?'} is too old`
        : !status.providersImported
          ? 'moxxy ready — providers not imported yet'
          : `moxxy ${status.cliVersion} ready`;

  // Whether moxxy is healthy only bears on this dot when moxxy is what your
  // work runs on. Having picked another runtime, a missing or outdated moxxy
  // CLI is a fact about software you are not using, and colouring the whole
  // indicator red for it reports an outage that is not happening.
  const moxxyInUse = lane === null || lane.harness === null || lane.harness === 'moxxy';

  // healthy: all green · degraded: soft warnings only · unhealthy: something
  // is down · offline: the daemon itself is unreachable.
  const anyDown = (moxxyInUse && !moxxyOk) || !status?.githubConfigured || ws === 'offline';
  const anyWarn = (moxxyInUse && !status?.providersImported) || ws === 'connecting';
  const overall: 'healthy' | 'degraded' | 'unhealthy' | 'offline' = !status
    ? 'offline'
    : anyDown
      ? 'unhealthy'
      : anyWarn
        ? 'degraded'
        : 'healthy';
  const dotColor =
    overall === 'healthy' ? 'bg-emerald-500' : overall === 'degraded' ? 'bg-amber-500' : 'bg-red-500';

  const n = liveIds.size;
  const label = n === 1 ? '1 live agent' : `${n} live agents`;

  return (
    <div className="group relative">
      <a
        href="#/runs"
        className="dim flex items-center gap-2 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs transition-colors hover:bg-zinc-100 hover:text-zinc-800 dark:border-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        aria-label={`${label} — system ${overall}. Open Agent Runs.`}
      >
        <span
          className={`size-2 rounded-full ${dotColor} ${n > 0 ? 'animate-pulse motion-reduce:animate-none' : ''}`}
          aria-hidden
        />
        <span className="font-medium tabular-nums">{n}</span>
      </a>
      <div
        role="status"
        aria-label="Connection status details"
        className="invisible absolute top-full right-0 z-40 mt-1.5 flex w-56 flex-col gap-2 rounded-lg border border-zinc-200 bg-white p-3 opacity-0 shadow-lg transition-opacity group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100 dark:border-zinc-700 dark:bg-zinc-900"
      >
        <div className="dim text-[10px] font-medium tracking-widest uppercase">{overall}</div>
        <StatusDot ok={moxxyOk} degraded={moxxyOk && !status?.providersImported} label="Runtime" title={moxxyTitle} />
        <StatusDot
          ok={Boolean(status?.githubConfigured)}
          label="GitHub"
          title={
            status?.githubConfigured ? `GitHub connected as ${status.githubUser ?? '…'}` : 'GitHub PAT not configured'
          }
        />
        <StatusDot
          ok={ws === 'connected'}
          degraded={ws === 'connecting'}
          label="Platform"
          title={ws === 'connected' ? 'Event stream connected' : ws === 'connecting' ? 'Reconnecting…' : 'Event stream offline'}
        />
      </div>
    </div>
  );
}

/** One labelled dot inside the popover: green healthy, amber degraded, red down. */
function StatusDot({
  ok,
  degraded,
  label,
  title,
}: {
  ok: boolean;
  degraded?: boolean;
  label: string;
  title: string;
}): JSX.Element {
  return (
    <span className="dim flex items-center gap-1.5 text-xs" title={title} role="status" aria-label={title}>
      <Dot tone={ok ? (degraded ? 'amber' : 'green') : 'red'} />
      {label}
    </span>
  );
}
