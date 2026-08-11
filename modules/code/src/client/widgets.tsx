import { CheckIcon, ClockIcon, CloseIcon, QuestionIcon, Tooltip } from '@moxxy/companion-sdk/ui';
import { useAuth } from '@companion/module-core/client';
import type { ChecksSnapshot, IssueRecord, PipelineRunStatus, StepResultStatus } from '@companion/module-code/contract';

/**
 * GitHub/code-domain widgets split out of the web ui kit — PR/issue/triage/
 * checks/pipeline semantics for list rows and detail views. Generic primitives
 * (Tooltip & co.) come from @moxxy/companion-ui.
 */

// ---------- status renderers ---------------------------------------------------

/**
 * CI snapshot as a compact SVG icon — shape + color, never color alone; the
 * counts live in the tooltip and aria-label.
 */
export function ChecksIcon({ checks }: { checks: ChecksSnapshot | null }): React.JSX.Element | null {
  if (!checks || checks.state === 'none') return null;
  const spec =
    checks.state === 'passing'
      ? {
          cls: 'text-emerald-600 dark:text-emerald-400',
          icon: <CheckIcon />,
          label: `CI passing — ${checks.passed}/${checks.total} checks`,
        }
      : checks.state === 'failing'
        ? {
            cls: 'text-red-600 dark:text-red-400',
            icon: <CloseIcon />,
            label: `CI failing — ${checks.failed} of ${checks.total} checks failing`,
          }
        : checks.state === 'unknown'
          ? {
              cls: 'text-zinc-500 dark:text-zinc-400',
              icon: <QuestionIcon />,
              label: 'CI status unavailable — could not fetch from GitHub',
            }
          : {
              cls: 'text-amber-600 dark:text-amber-400',
              icon: <ClockIcon />,
              label: `CI running — ${checks.pending} of ${checks.total} checks pending`,
            };
  return (
    <Tooltip
      content={
        checks.state === 'unknown'
          ? 'CI status unavailable — GitHub fetch failed (check token permissions)'
          : `CI: ${checks.passed} passed, ${checks.failed} failed, ${checks.pending} running`
      }
    >
      <span className={`inline-flex size-4 shrink-0 items-center justify-center ${spec.cls}`} role="img" aria-label={spec.label}>
        {spec.icon}
      </span>
    </Tooltip>
  );
}

export function pipelineStatusBadge(status: PipelineRunStatus | StepResultStatus): string {
  switch (status) {
    case 'passed':
      return 'badge-ok';
    case 'failed':
    case 'error':
      return 'badge-danger';
    case 'cancelled':
      return 'badge';
    case 'running':
      return 'badge-accent';
    default:
      return 'badge';
  }
}

const PR_STATE_GLYPHS = {
  pr: (
    <>
      <circle cx="4.5" cy="3.5" r="1.7" />
      <circle cx="4.5" cy="12.5" r="1.7" />
      <circle cx="11.5" cy="12.5" r="1.7" />
      <path d="M4.5 5.4v5.2M8 3.5h2A1.5 1.5 0 0 1 11.5 5v5.6" />
    </>
  ),
  merge: (
    <>
      <circle cx="4.5" cy="3.5" r="1.7" />
      <circle cx="4.5" cy="12.5" r="1.7" />
      <circle cx="11.5" cy="8.5" r="1.7" />
      <path d="M4.5 5.4v5.2M4.5 5.8c.4 2.3 2.6 2.7 5.1 2.7" />
    </>
  ),
  check: (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="m5.4 8.2 1.8 1.8 3.4-3.9" />
    </>
  ),
  diff: (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.6v3.6M6.2 6.4h3.6M6.2 10.6h3.6" />
    </>
  ),
  closed: (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="m5.9 5.9 4.2 4.2M10.1 5.9l-4.2 4.2" />
    </>
  ),
} as const;

/**
 * Leading PR state icon: review decision when there is one, else lifecycle
 * state — color + glyph, never a space-eating pill. Details on hover.
 */
export function PrStateIcon({
  state,
  draft = false,
  decision = null,
  className = '',
}: {
  state: 'open' | 'merged' | 'closed';
  draft?: boolean;
  decision?: 'approved' | 'changes_requested' | null;
  className?: string;
}): React.JSX.Element {
  const spec =
    state === 'open' && decision === 'changes_requested'
      ? { label: 'Changes requested', cls: 'text-red-600 dark:text-red-400', glyph: PR_STATE_GLYPHS.diff }
      : state === 'open' && decision === 'approved'
        ? { label: 'Approved', cls: 'text-emerald-600 dark:text-emerald-400', glyph: PR_STATE_GLYPHS.check }
        : state === 'merged'
          ? { label: 'Merged', cls: 'text-[#2a78d6] dark:text-[#3987e5]', glyph: PR_STATE_GLYPHS.merge }
          : state === 'closed'
            ? { label: 'Closed without merging', cls: 'text-red-600 dark:text-red-400', glyph: PR_STATE_GLYPHS.closed }
            : draft
              ? { label: 'Draft', cls: 'text-zinc-400 dark:text-zinc-500', glyph: PR_STATE_GLYPHS.pr }
              : { label: 'Open', cls: 'text-emerald-600 dark:text-emerald-400', glyph: PR_STATE_GLYPHS.pr };
  const label = draft && state === 'open' ? `${spec.label} · draft` : spec.label;
  return (
    <Tooltip content={label} className={className}>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`size-4 shrink-0 ${spec.cls}`}
        role="img"
        aria-label={label}
      >
        {spec.glyph}
      </svg>
    </Tooltip>
  );
}

const TRIAGE_STATE_SPECS = {
  none: {
    label: 'Not triaged',
    cls: 'text-zinc-300 dark:text-zinc-600',
    glyph: (
      <>
        <circle cx="8" cy="8" r="6.2" />
        <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
      </>
    ),
  },
  running: {
    label: 'Triage running',
    cls: 'animate-pulse text-sky-600 dark:text-sky-400',
    glyph: (
      <>
        <circle cx="8" cy="8" r="6.2" />
        <path d="M8 4.8V8l2.1 1.5" />
      </>
    ),
  },
  pending: {
    label: 'Triage pending',
    cls: 'text-amber-600 dark:text-amber-400',
    glyph: (
      <>
        <circle cx="8" cy="8" r="6.2" />
        <path d="M8 4.9V8l2.2 1.6" />
      </>
    ),
  },
  applied: {
    label: 'Triage applied',
    cls: 'text-emerald-600 dark:text-emerald-400',
    glyph: (
      <>
        <circle cx="8" cy="8" r="6.2" />
        <path d="m5.4 8.2 1.8 1.8 3.4-3.9" />
      </>
    ),
  },
  dismissed: {
    label: 'Triage dismissed',
    cls: 'text-zinc-400 dark:text-zinc-500',
    glyph: (
      <>
        <circle cx="8" cy="8" r="6.2" />
        <path d="m5.9 5.9 4.2 4.2M10.1 5.9l-4.2 4.2" />
      </>
    ),
  },
} as const;

type TriageIconState = keyof typeof TRIAGE_STATE_SPECS;

function TriageGlyph({ state, className = 'size-4' }: { state: TriageIconState; className?: string }): React.JSX.Element {
  const spec = TRIAGE_STATE_SPECS[state];
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${spec.cls} ${className}`}
      role="img"
      aria-label={spec.label}
    >
      {spec.glyph}
    </svg>
  );
}

/**
 * Leading AI-triage state icon for issue rows — color + glyph, never a
 * space-eating pill. The label lives in the tooltip; TriageLegend spells the
 * states out under the list.
 */
export function TriageStateIcon({ triage, className = '' }: { triage: IssueRecord['triage']; className?: string }): React.JSX.Element {
  const state: TriageIconState = triage ?? 'none';
  return (
    <Tooltip content={TRIAGE_STATE_SPECS[state].label} className={className}>
      <TriageGlyph state={state} />
    </Tooltip>
  );
}

/** What the issue-row triage icons mean; sits under the issue list. */
export function TriageLegend(): React.JSX.Element {
  return (
    <div className="dim mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 px-1">
      {(Object.keys(TRIAGE_STATE_SPECS) as TriageIconState[]).map((state) => (
        <span key={state} className="flex items-center gap-1.5">
          <TriageGlyph state={state} className="size-3.5" />
          {TRIAGE_STATE_SPECS[state].label}
        </span>
      ))}
    </div>
  );
}

/**
 * Clickable GitHub handle: opens the profile in a new tab. Rendered as a
 * role=link span so it can sit inside list-row anchors without nesting <a>s.
 */
export function GitHubUser({ login, className = '' }: { login: string; className?: string }): React.JSX.Element {
  const { githubHost } = useAuth();
  const open = (): void => {
    window.open(`https://${githubHost}/${encodeURIComponent(login)}`, '_blank', 'noopener');
  };
  return (
    <Tooltip content={`Open @${login} on GitHub ↗`}>
      <span
        role="link"
        tabIndex={0}
        className={`cursor-pointer hover:underline ${className}`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          open();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            open();
          }
        }}
      >
        {login}
      </span>
    </Tooltip>
  );
}

/** Compact label display for list rows: first label + "+N more" (rest on hover). */
export function LabelChips({ labels }: { labels: ReadonlyArray<string> }): React.JSX.Element | null {
  if (labels.length === 0) return null;
  return (
    <Tooltip content={labels.join(', ')}>
      <span className="flex shrink-0 items-center gap-1">
        <span className="chip max-w-32 truncate">{labels[0]}</span>
        {labels.length > 1 ? <span className="chip">+{labels.length - 1} more</span> : null}
      </span>
    </Tooltip>
  );
}

/** "assigned a +2 more" for list rows; the rest of the names on hover. */
export function AssigneeNote({ assignees }: { assignees: ReadonlyArray<string> }): React.JSX.Element | null {
  if (assignees.length === 0) return null;
  return (
    <span className="dim shrink-0 text-xs">
      assigned <GitHubUser login={assignees[0]!} />
      {assignees.length > 1 ? (
        <Tooltip content={assignees.slice(1).join(', ')}>
          <span className="cursor-default">&nbsp;+{assignees.length - 1} more</span>
        </Tooltip>
      ) : null}
    </span>
  );
}

/** Speech-bubble + count for list rows; hidden when there are no comments. */
export function CommentCount({ count }: { count: number }): React.JSX.Element {
  return (
    <Tooltip content={`${count} comment${count === 1 ? '' : 's'}`}>
    <span className={`dim flex shrink-0 items-center gap-1 text-xs ${count === 0 ? 'opacity-50' : ''}`}>
      <svg viewBox="0 0 16 16" fill="none" className="size-3.5" aria-hidden>
        <path
          d="M14 10.5a1.5 1.5 0 0 1-1.5 1.5H8l-3 2.5V12H3.5A1.5 1.5 0 0 1 2 10.5v-6A1.5 1.5 0 0 1 3.5 3h9A1.5 1.5 0 0 1 14 4.5v6z"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      </svg>
      <span className="tabular-nums">{count}</span>
    </span>
    </Tooltip>
  );
}
