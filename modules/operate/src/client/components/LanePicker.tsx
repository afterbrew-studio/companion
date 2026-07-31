import { useCallback, useEffect, useRef, useState } from 'react';
import { onServerMessage } from '@moxxy/companion-core/client';
import { ChevronDown, GearIcon, Portal, Spinner } from '@moxxy/companion-ui';
import type { RunLane } from '../../contract/index.js';
import { useAuth } from '@companion/module-core/client';
import { operateApi as api, type LaneSnapshot } from '../api.js';

/**
 * Where this person's own actions run: a machine, and the agent runtime on it.
 *
 * Sits at the foot of the sidebar because it is ambient context, like the
 * workspace at the top: you set it once and everything you click afterwards
 * obeys it. What it does NOT govern is unattended work — a webhook or a
 * schedule has nobody's session to inherit — and the wording says so rather
 * than letting people assume otherwise.
 */
export function LanePicker({ rail }: { rail?: boolean }): JSX.Element | null {
  const [snapshot, setSnapshot] = useState<LaneSnapshot | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { can } = useAuth();
  const [filter, setFilter] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);

  const load = useCallback(() => {
    api
      .lane()
      .then(setSnapshot)
      .catch(() => setSnapshot(null));
  }, []);

  useEffect(() => {
    load();
    // A machine going away, or its runtimes changing, changes what this can
    // offer; the chosen lane may stop being available at all.
    return onServerMessage((msg) => {
      if (msg.t === 'runners.changed') load();
    });
  }, [load]);

  // A menu that only closes by choosing something traps anyone who opened it
  // to look.
  useEffect(() => {
    if (!open) return;
    if (rail) {
      const box = boxRef.current?.getBoundingClientRect();
      if (box) setAnchor({ left: box.right + 8, bottom: window.innerHeight - box.bottom });
    }
    const onDown = (e: MouseEvent): void => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, rail]);

  const choose = async (lane: RunLane): Promise<void> => {
    setBusy(true);
    try {
      setSnapshot(await api.setLane(lane));
      setOpen(false);
      setFilter('');
    } finally {
      setBusy(false);
    }
  };

  if (!snapshot) return null;
  const { lane, machines } = snapshot;
  const machine = machines.find((m) => m.id === lane.runnerId) ?? null;
  const harness = machine?.harnesses.find((h) => h.id === lane.harness) ?? null;
  const label = machine === null ? 'Auto' : harness ? `${machine.name} · ${harness.label}` : machine.name;
  // Auto is the default and means "nothing chosen", so it stays quiet. A lane
  // someone picked is the case worth showing, and only then does this earn
  // colour in a footer that is otherwise chrome.
  const chosen = machine !== null;

  // Search earns its space only once the list stops fitting in a glance; below
  // that it is one more thing to skip past on the way to two options.
  const laneCount = machines.reduce((n, m) => n + m.harnesses.length, 0);
  const searchable = laneCount > 8;
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? machines
        .map((m) => ({
          ...m,
          harnesses: m.name.toLowerCase().includes(needle)
            ? m.harnesses
            : m.harnesses.filter((h) => h.label.toLowerCase().includes(needle)),
        }))
        .filter((m) => m.harnesses.length > 0)
    : machines;

  /**
   * Task models is gated on `settings:manage` while this picker is a slot every
   * user who can read runs sees, and its lane list carries shared machines
   * only. Offering the cog otherwise is a dead end on "no access", or a page
   * whose "Applies to" select has no option for the lane it was handed.
   */
  const canConfigure = (m: (typeof machines)[number]): boolean =>
    can('settings:manage') && (snapshot.lanesConfigurable?.includes(m.id) ?? true);

  const menu = (
    <div
      // Sized to the sidebar rather than to a guess: the aside is `w-56` with
      // `overflow-hidden`, so anything wider loses its right edge, which is
      // where the per-runtime cog sits.
      className={`z-30 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-lg dark:border-zinc-800 dark:bg-zinc-900 ${
        rail ? 'fixed w-64' : 'absolute bottom-full left-0 mb-1 w-full'
      }`}
      style={rail && anchor ? { left: anchor.left, bottom: anchor.bottom } : undefined}
      role="menu"
    >
      {searchable ? (
        <div className="border-b border-zinc-200 p-2 dark:border-zinc-800">
          <input
            className="input input-sm w-full"
            placeholder="Filter machines and runtimes"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter"
            autoFocus
          />
        </div>
      ) : null}
      <div className="max-h-80 overflow-y-auto">
      <Option
        label="Auto"
        hint="Wherever each run fits"
        active={lane.runnerId === null}
        onSelect={() => void choose({ runnerId: null, harness: null })}
      />
      {shown.map((m) => (
        <div key={m.id} className="border-t border-zinc-200 dark:border-zinc-800">
          {/* The machine heads the group so its name has a whole line to be
              long in, and each runtime row carries only the short label. */}
          <div className="flex items-baseline gap-2 px-3 pt-2 pb-1">
            <span className="dim min-w-0 flex-1 truncate text-[10px] tracking-wide uppercase">{m.name}</span>
            {m.status === 'online' ? null : <span className="dim shrink-0 text-[10px]">{m.status}</span>}
          </div>
          {m.harnesses.map((h) => (
            <Option
              key={`${m.id}:${h.id}`}
              label={h.label}
              hint={m.status === 'online' ? undefined : 'runs will queue'}
              active={lane.runnerId === m.id && lane.harness === h.id}
              onSelect={() => void choose({ runnerId: m.id, harness: h.id })}
              {...(canConfigure(m)
                ? {
                    configureHref: `#/task-models?runner=${encodeURIComponent(m.id)}&harness=${encodeURIComponent(h.id)}`,
                  }
                : {})}
              onNavigate={() => {
                setOpen(false);
                setFilter('');
              }}
            />
          ))}
        </div>
      ))}
      {shown.length === 0 ? <p className="dim px-3 py-3 text-[12px]">Nothing matches.</p> : null}
      </div>
      <p className="dim border-t border-zinc-200 px-3 py-2 text-[11px] leading-snug dark:border-zinc-800">
        Applies to what you start yourself.
      </p>
    </div>
  );

  return (
    <div className={`relative ${rail ? '' : '-mx-1.5 w-[calc(100%+0.75rem)]'}`} ref={boxRef}>
      <button
        type="button"
        className={`group flex items-center gap-2 rounded-lg transition-colors hover:bg-zinc-200 dark:hover:bg-zinc-800 ${
          rail ? 'w-fit p-1.5' : 'w-full px-2.5 py-1'
        }`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`Runs on ${label}`}
        title={`Runs on ${label}`}
      >
        <LaneIcon className={chosen ? 'text-accent-500' : 'dim'} />
        {rail ? null : (
          <>
            {/* The runtime is what changes how the agent behaves, so it stays
                whole and the machine name is what gets cut. A label truncated
                to "MacBook-Air-Michal.loc…" answers the less useful half. */}
            <span className={`flex min-w-0 flex-1 items-baseline gap-1 text-left text-[12px] ${chosen ? '' : 'dim'}`}>
              <span className="min-w-0 truncate">{machine?.name ?? label}</span>
              {harness ? <span className="dim shrink-0">· {harness.label}</span> : null}
            </span>
            {busy ? (
              <Spinner />
            ) : (
              <ChevronDown open={open} className="dim size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
            )}
          </>
        )}
      </button>
      {/* Collapsed, the sidebar is far too narrow to hold this and clips it
          besides, so it leaves the aside entirely and is placed against the
          trigger. */}
      {open ? (rail ? <Portal>{menu}</Portal> : menu) : null}
    </div>
  );
}

function Option({
  label,
  hint,
  active,
  onSelect,
  configureHref,
  onNavigate,
}: {
  label: string;
  hint?: string;
  active: boolean;
  onSelect: () => void;
  /** Where this lane's model pins are set; absent on Auto, which has none. */
  configureHref?: string;
  onNavigate?: () => void;
}): JSX.Element {
  return (
    <div
      className={`group/opt flex items-center transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
        active ? 'bg-zinc-100 dark:bg-zinc-800' : ''
      }`}
    >
      <button type="button" className="flex min-w-0 flex-1 flex-col items-start px-3 py-2 text-left" onClick={onSelect}>
        <span className="w-full truncate text-[13px]">{label}</span>
        {hint ? <span className="dim truncate text-[11px]">{hint}</span> : null}
      </button>
      {configureHref ? (
        <a
          href={configureHref}
          className="dim mr-2 shrink-0 rounded p-1.5 opacity-0 transition-opacity group-hover/opt:opacity-100 hover:bg-zinc-200 hover:text-zinc-800 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
          title="Model pins for this runtime"
          aria-label={`Model pins for ${label}`}
          // Leaving for another page: a menu still hanging over the sidebar
          // after the click has taken effect reads as a click that missed.
          onClick={onNavigate}
        >
          <GearIcon className="size-3.5" />
        </a>
      ) : null}
    </div>
  );
}

function LaneIcon({ className = '' }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`size-4 shrink-0 ${className}`} aria-hidden>
      <rect x="3" y="4" width="18" height="7" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <rect x="3" y="14" width="18" height="6" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M7 7.5h.01M7 17h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
