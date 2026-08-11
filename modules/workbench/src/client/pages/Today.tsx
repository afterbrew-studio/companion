import { useCallback, useEffect, useMemo, useState } from 'react';
import { useWorkspace } from '@companion/module-workspace/client';
import { useAuth } from '@companion/module-core/client';
import { runIntent, useModuleEnabled } from '@moxxy/companion-sdk/client';
import {
  CheckIcon,
  ClockIcon,
  EmptyState,
  ErrorBar,
  Eyebrow,
  ListCard,
  Page,
  PageHeader,
  RowsSkeleton,
  StatusDot,
  timeAgo,
  type StatusTone,
} from '@moxxy/companion-sdk/ui';
import type { DecisionItem, DecisionKind, DecisionSubject } from '../../contract/index.js';
import { PreparedActionsView } from '../components/PreparedActions.js';
import { useDecisions } from '../hooks/useDecisions.js';
import { useWorkbenchActions } from '../hooks/useWorkbenchActions.js';

const KIND_LABEL: Record<DecisionKind, string> = {
  'board-failure': 'Blocked automation',
  'board-merge': 'Merge decision',
  'agent-change': 'Agent change',
  'pull-request-review': 'AI review',
  'issue-triage': 'Issue triage',
};

const SNOOZE_MS = 4 * 60 * 60 * 1_000;

interface DecisionTriageState {
  readonly focus: readonly string[];
  readonly snoozed: Readonly<Record<string, number>>;
}

const EMPTY_TRIAGE: DecisionTriageState = { focus: [], snoozed: {} };

/** The front door: approvals first, then a lightweight queue of human decisions. */
export default function TodayPage(): React.JSX.Element {
  const { current } = useWorkspace();
  const { can, user } = useAuth();
  const hasAiHelp = useModuleEnabled('automations') && can('runs:read') && can('runs:act');
  const decisions = useDecisions(current?.id);
  const prepared = useWorkbenchActions(current?.id, Boolean(current));
  const triage = useDecisionTriage(current?.id, user?.username, decisions.items, decisions.loaded);

  if (!current) {
    return (
      <Page>
        <PageHeader title="Today" subtitle="The work that needs a human decision" />
        <EmptyState
          title="No workspace yet"
          hint="Create a workspace first. Companion will then guide you to connect a repository."
          action={
            can('workspaces:create') ? (
              <button className="btn" onClick={() => runIntent('new-workspace')}>Create workspace</button>
            ) : undefined
          }
        />
      </Page>
    );
  }

  const loaded = decisions.loaded && prepared.loaded;
  const error = decisions.error ?? prepared.error;
  const domainCount = decisions.items.length + prepared.actions.length;

  return (
    <Page>
      <PageHeader
        title="Today"
        subtitle={queueSummary(
          current.name,
          loaded,
          error,
          triage.reviewable.length,
          triage.focused.length,
          prepared.actions.length,
        )}
      />
      <ErrorBar error={decisions.error} />
      <PreparedActionsView feed={prepared} />

      {!loaded ? (
        <ListCard>
          <RowsSkeleton rows={5} />
        </ListCard>
      ) : error && domainCount === 0 ? null : domainCount === 0 && current.repoCount === 0 ? (
        <EmptyState
          title="Connect your first repository"
          hint="Today becomes useful as soon as Companion can see the issues, pull requests, and agent work in this workspace."
          action={
            can('repos:manage') ? (
              <button className="btn" onClick={() => runIntent('connect-repo')}>Connect repository</button>
            ) : undefined
          }
        />
      ) : domainCount === 0 ? (
        <EmptyState
          title="Decision queue is clear"
          hint="Nothing needs your approval. You can leave Companion here, or ask about the workspace without hunting through pages."
          action={
            hasAiHelp ? (
              <button className="btn-ghost" onClick={() => runIntent('ask-ai')}>Ask AI Help</button>
            ) : undefined
          }
        />
      ) : decisions.items.length > 0 ? (
        <DecisionQueue triage={triage} hasMore={decisions.hasMore} />
      ) : null}
    </Page>
  );
}

function DecisionQueue({
  triage,
  hasMore,
}: {
  readonly triage: DecisionTriage;
  readonly hasMore: boolean;
}): React.JSX.Element {
  return (
    <section aria-label="Decisions to review">
      {triage.reviewable.length > 0 ? (
        <ListCard ariaLabel="Decisions waiting for review">
          {triage.reviewable.map((item) => (
            <DecisionRow
              key={item.id}
              item={item}
              onFocus={() => triage.doNext(item.id)}
              onSnooze={() => triage.snooze(item.id)}
            />
          ))}
        </ListCard>
      ) : (
        <div className="card py-8 text-center">
          <div className="text-sm font-medium">Triage is caught up</div>
          <p className="dim mx-auto mt-1 max-w-md text-[13px]">
            Your selected work stays below. Snoozed decisions will return automatically.
          </p>
        </div>
      )}

      {triage.snoozedCount > 0 ? (
        <div className="dim mt-3 flex items-center justify-center gap-2 text-xs">
          <span>{triage.snoozedCount} snoozed for up to 4 hours</span>
          <button type="button" className="linkish text-xs" onClick={triage.reviewSnoozed}>
            Review now
          </button>
        </div>
      ) : null}

      {triage.focused.length > 0 ? (
        <div className="mt-6">
          <div className="mb-2 flex items-end justify-between gap-3">
            <div>
              <Eyebrow>Do next</Eyebrow>
              <h3 className="mt-0.5 text-sm font-semibold">Work you chose to keep at hand</h3>
            </div>
            <span className="dim text-xs">selection only · source state is unchanged</span>
          </div>
          <ListCard ariaLabel="Decisions selected to do next">
            {triage.focused.map((item) => (
              <FocusedDecisionRow key={item.id} item={item} onReturn={() => triage.returnToQueue(item.id)} />
            ))}
          </ListCard>
        </div>
      ) : null}

      {hasMore ? (
        <p className="dim mt-3 text-xs">
          Today keeps this queue bounded to 200 decisions. Open the owning area from a card for the complete history.
        </p>
      ) : null}
    </section>
  );
}

function DecisionRow({
  item,
  onFocus,
  onSnooze,
}: {
  readonly item: DecisionItem;
  readonly onFocus: () => void;
  readonly onSnooze: () => void;
}): React.JSX.Element {
  return (
    <article className="flex flex-col gap-3 px-3.5 py-3.5 md:flex-row md:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <StatusDot tone={toneOf(item.kind)} className="mt-1.5" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="font-medium">{item.title}</span>
            <span className="dim text-[11px] font-medium tracking-wide uppercase">
              {KIND_LABEL[item.kind]} · {subjectLabel(item.subject)} · {timeAgo(item.updatedAt)}
            </span>
          </div>
          <p className="dim mt-1 text-xs">{item.reason}</p>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 pl-5 md:pl-0">
        <button
          type="button"
          className="btn-ghost gap-1.5"
          title="Hide this decision for four hours"
          onClick={onSnooze}
        >
          <ClockIcon />
          Snooze 4h
        </button>
        <button
          type="button"
          className="btn-ghost gap-1.5"
          title="Keep this decision in your personal focus list"
          onClick={onFocus}
        >
          <CheckIcon />
          Do next
        </button>
        <a className="btn" href={item.href}>
          {item.nextAction}
          <span aria-hidden>→</span>
        </a>
      </div>
    </article>
  );
}

function FocusedDecisionRow({
  item,
  onReturn,
}: {
  readonly item: DecisionItem;
  readonly onReturn: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 px-3.5 py-3 sm:flex-row sm:items-start">
      <StatusDot tone={toneOf(item.kind)} className="mt-1.5" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-medium">{item.title}</span>
          <span className="dim text-[11px] font-medium tracking-wide uppercase">
            {KIND_LABEL[item.kind]} · {subjectLabel(item.subject)}
          </span>
        </div>
        <p className="dim mt-0.5 text-xs">{item.reason}</p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 sm:self-center">
        <button type="button" className="btn-ghost" onClick={onReturn}>Return</button>
        <a className="btn" href={item.href}>Open</a>
      </div>
    </div>
  );
}

interface DecisionTriage {
  readonly reviewable: readonly DecisionItem[];
  readonly focused: readonly DecisionItem[];
  readonly snoozedCount: number;
  doNext(id: string): void;
  snooze(id: string): void;
  returnToQueue(id: string): void;
  reviewSnoozed(): void;
}

/**
 * Personal triage is intentionally browser state, not a second task system.
 * The owning issue/PR/run remains authoritative; resolving it removes the card.
 */
function useDecisionTriage(
  workspaceId: string | undefined,
  username: string | undefined,
  items: readonly DecisionItem[],
  loaded: boolean,
): DecisionTriage {
  const key = workspaceId && username ? `companion.today:${username}:${workspaceId}` : null;
  const [snapshot, setSnapshot] = useState<{ readonly key: string | null; readonly state: DecisionTriageState }>(
    () => ({ key, state: key ? readTriage(key) : EMPTY_TRIAGE }),
  );
  const [clock, setClock] = useState(() => Date.now());

  useEffect(() => {
    setSnapshot({ key, state: key ? readTriage(key) : EMPTY_TRIAGE });
    setClock(Date.now());
  }, [key]);

  const state = snapshot.key === key ? snapshot.state : EMPTY_TRIAGE;
  const update = useCallback(
    (change: (previous: DecisionTriageState) => DecisionTriageState): void => {
      if (!key) return;
      setSnapshot((current) => {
        const previous = current.key === key ? current.state : readTriage(key);
        const next = change(previous);
        writeTriage(key, next);
        return { key, state: next };
      });
    },
    [key],
  );

  const itemIds = items.map((item) => item.id).join('\u0000');
  useEffect(() => {
    if (!loaded || !key || snapshot.key !== key) return;
    const live = new Set(itemIds ? itemIds.split('\u0000') : []);
    const now = Date.now();
    const focus = state.focus.filter((id) => live.has(id));
    const snoozed = Object.fromEntries(
      Object.entries(state.snoozed).filter(([id, until]) => live.has(id) && until > now),
    );
    if (sameArray(focus, state.focus) && sameRecord(snoozed, state.snoozed)) return;
    update(() => ({ focus, snoozed }));
  }, [loaded, key, snapshot.key, itemIds, clock, state.focus, state.snoozed, update]);

  const nextWake = Math.min(...Object.values(state.snoozed).filter((until) => until > clock));
  useEffect(() => {
    if (!Number.isFinite(nextWake)) return;
    const delay = Math.max(250, Math.min(60_000, nextWake - Date.now() + 50));
    const timer = window.setTimeout(() => setClock(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [nextWake, clock]);

  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const focusSet = useMemo(() => new Set(state.focus), [state.focus]);
  const snoozedSet = useMemo(
    () => new Set(Object.entries(state.snoozed).filter(([, until]) => until > clock).map(([id]) => id)),
    [state.snoozed, clock],
  );
  const reviewable = useMemo(
    () => items.filter((item) => !focusSet.has(item.id) && !snoozedSet.has(item.id)),
    [items, focusSet, snoozedSet],
  );
  const focused = useMemo(
    () => state.focus.map((id) => byId.get(id)).filter((item): item is DecisionItem => item !== undefined),
    [state.focus, byId],
  );

  return {
    reviewable,
    focused,
    snoozedCount: snoozedSet.size,
    doNext: (id) =>
      update((previous) => {
        const snoozed = Object.fromEntries(Object.entries(previous.snoozed).filter(([itemId]) => itemId !== id));
        return { focus: [...previous.focus.filter((itemId) => itemId !== id), id], snoozed };
      }),
    snooze: (id) =>
      update((previous) => ({
        focus: previous.focus.filter((itemId) => itemId !== id),
        snoozed: { ...previous.snoozed, [id]: Date.now() + SNOOZE_MS },
      })),
    returnToQueue: (id) =>
      update((previous) => ({ ...previous, focus: previous.focus.filter((itemId) => itemId !== id) })),
    reviewSnoozed: () => update((previous) => ({ ...previous, snoozed: {} })),
  };
}

function readTriage(key: string): DecisionTriageState {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
    if (!parsed || typeof parsed !== 'object') return EMPTY_TRIAGE;
    const value = parsed as { readonly focus?: unknown; readonly snoozed?: unknown };
    const focus = Array.isArray(value.focus)
      ? [...new Set(value.focus.filter((id): id is string => typeof id === 'string'))]
      : [];
    const snoozed =
      value.snoozed && typeof value.snoozed === 'object'
        ? Object.fromEntries(
            Object.entries(value.snoozed).filter(
              (entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]),
            ),
          )
        : {};
    return { focus, snoozed };
  } catch {
    return EMPTY_TRIAGE;
  }
}

function writeTriage(key: string, state: DecisionTriageState): void {
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch {
    // A full/blocked localStorage only makes this triage session ephemeral.
  }
}

function sameArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameRecord(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

function toneOf(kind: DecisionKind): StatusTone {
  return kind === 'board-failure' ? 'red' : 'amber';
}

function queueSummary(
  workspace: string,
  loaded: boolean,
  error: string | null,
  reviewable: number,
  focused: number,
  approvals: number,
): string {
  if (!loaded) return `${workspace} · loading decisions`;
  if (error) return `${workspace} · some decisions are unavailable`;
  const parts = [
    approvals > 0 ? `${approvals} approval${approvals === 1 ? '' : 's'}` : null,
    reviewable > 0 ? `${reviewable} to review` : null,
    focused > 0 ? `${focused} do next` : null,
  ].filter((part): part is string => part !== null);
  return `${workspace} · ${parts.length > 0 ? parts.join(' · ') : 'queue clear'}`;
}

function subjectLabel(subject: DecisionSubject): string {
  switch (subject.type) {
    case 'pull-request':
    case 'issue':
      return `${subject.repo} #${subject.number}`;
    case 'task':
      return subject.repo;
    case 'run':
      return subject.repo ?? subject.id;
    case 'content':
      return subject.repo ?? 'workspace';
  }
}
