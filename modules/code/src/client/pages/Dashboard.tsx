import { useState } from 'react';
import { pipelineRunHref, reportHref, runHref, useKernel, useModuleEnabled } from '@moxxy/companion-sdk/client';
import { useAuth } from '@companion/module-core/client';
import type { RunListRecord } from '@companion/module-operate/contract';
import type { ReportRecord, WeeklyCounts, WorkspaceMetrics } from '@companion/module-workspace/contract';
import { ChartSkeleton, EmptyState, ErrorBar, ListCard, Page, PageHeader, RowsSkeleton, Spinner, StatTile, StatusDot, timeAgo, type StatusTone } from '@moxxy/companion-sdk/ui';
import type { PipelineRunRecord } from '../../contract/index.js';
import { useOverview } from '../hooks/useOverview.js';
import { ChecksIcon } from '../widgets.js';

/**
 * Workspace overview: headline numbers plus the "needs a human" queues —
 * fix/implement runs waiting for review, PRs with failing CI, proposals ready
 * to approve.
 */
export function DashboardPage(): React.JSX.Element {
  const o = useOverview();

  if (!o.hasWorkspace) {
    return (
      <Page>
        <EmptyState
          title="No workspace yet"
          hint="An admin can create workspaces and connect repositories under Repositories."
        />
      </Page>
    );
  }

  const {
    workspaceName,
    error,
    repos,
    metrics,
    workspaceRuns,
    workspaceReports,
    pipelineRuns,
    openIssueCount,
    openPrCount,
    openPrs,
    failingPrs,
    liveRuns,
    reviewRuns,
    actionableProposals,
    prReviewsPending,
    triagePending,
    attentionCount,
    issueBacklog,
    prBacklog,
    issueBacklogDelta,
    prBacklogDelta,
  } = o;
  const planEnabled = useModuleEnabled('plan');

  return (
    <Page>
      <PageHeader
        title="Overview"
        subtitle={repos ? `${workspaceName} — ${repos.length} repositories` : workspaceName}
      />
      <ErrorBar error={error} />

      {/* Every tile renders its frame immediately; the value is a skeleton
          until that tile's own feed lands. */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatTile
          label="Open issues"
          loading={openIssueCount === null}
          value={openIssueCount ?? 0}
          href="#/issues"
          delta={issueBacklogDelta}
          trend={issueBacklog ?? undefined}
        />
        <StatTile
          label="Open PRs"
          loading={openPrCount === null}
          value={openPrCount ?? 0}
          href="#/prs"
          delta={prBacklogDelta}
          trend={prBacklog ?? undefined}
        />
        <StatTile
          label="Failing CI"
          loading={failingPrs === null}
          value={failingPrs?.length ?? 0}
          tone={failingPrs && failingPrs.length > 0 ? 'danger' : 'ok'}
          hint={
            failingPrs ? (failingPrs.length > 0 ? 'pull requests with red pipelines' : 'all pipelines green') : undefined
          }
          href="#/prs"
        />
        <StatTile
          label="Live agents"
          loading={liveRuns === null}
          value={liveRuns?.length ?? 0}
          tone={liveRuns && liveRuns.length > 0 ? 'ok' : 'default'}
          href="#/runs"
        />
        {/* plan owns proposals; without it there is no page to link to, and an
            empty archive is not worth a tile. */}
        {planEnabled && actionableProposals && actionableProposals.length > 0 ? (
          <StatTile
            label="Archived proposals"
            value={actionableProposals.length}
            tone="warn"
            href="#/legacy-proposals"
          />
        ) : null}
      </div>

      <MetricsSection metrics={metrics} />

      <UsageSection runs={workspaceRuns} />

      <DashboardSlots />

      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        <section aria-labelledby="needs-attention">
          <h2 id="needs-attention" className="mb-2 flex items-baseline justify-between text-sm font-semibold">
            Needs attention
            <a className="linkish text-xs font-normal" href="#/needs-attention">
              See all
            </a>
          </h2>
          <ListCard>
            {attentionCount === null ? <RowsSkeleton rows={3} /> : null}
            {reviewRuns?.map((run) => (
              <a key={run.id} href={`#/runs/${run.id}/preview`} className="row-link">
                <StatusDot tone="amber" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{run.title}</span>
                  <span className="dim block truncate text-xs">agent run needs review</span>
                </span>
                <span className="dim shrink-0">{timeAgo(run.updatedAt)}</span>
              </a>
            ))}
            {prReviewsPending?.slice(0, 6).map((pr) => (
              <a
                key={`rev-${pr.repo}#${pr.number}`}
                href={`#/repos/${pr.repo}/prs/${pr.number}/review`}
                className="row-link"
              >
                <StatusDot tone="amber" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{pr.title}</span>
                  <span className="dim block truncate text-xs">
                    AI review awaiting your decision · #{pr.number} · {pr.repo.split('/')[1]}
                  </span>
                </span>
                <span className="dim shrink-0">{timeAgo(pr.updatedAt)}</span>
              </a>
            ))}
            {triagePending?.slice(0, 6).map((issue) => (
              <a
                key={`tri-${issue.repo}#${issue.number}`}
                href={`#/repos/${issue.repo}/issues/${issue.number}`}
                className="row-link"
              >
                <StatusDot tone="amber" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{issue.title}</span>
                  <span className="dim block truncate text-xs">
                    triage awaiting your decision · #{issue.number} · {issue.repo.split('/')[1]}
                  </span>
                </span>
                <span className="dim shrink-0">{timeAgo(issue.updatedAt)}</span>
              </a>
            ))}
            {failingPrs?.slice(0, 6).map((pr) => (
              <a key={`${pr.repo}#${pr.number}`} href={`#/repos/${pr.repo}/prs/${pr.number}`} className="row-link">
                <ChecksIcon checks={pr.checks} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{pr.title}</span>
                  <span className="dim block truncate text-xs">
                    CI failing · #{pr.number} · {pr.repo.split('/')[1]}
                  </span>
                </span>
                <span className="dim shrink-0">{timeAgo(pr.updatedAt)}</span>
              </a>
            ))}
            {actionableProposals?.slice(0, 6).map((p) => (
              <a key={p.id} href="#/legacy-proposals" className="row-link">
                <StatusDot tone="amber" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{p.title}</span>
                  <span className="dim block truncate text-xs">
                    archived proposal {p.status === 'review' ? 'ready for review' : 'awaiting approval'}
                  </span>
                </span>
                <span className="dim shrink-0">{timeAgo(p.updatedAt)}</span>
              </a>
            ))}
            {attentionCount === 0 ? (
              <div className="dim px-4 py-6 text-center text-sm">Nothing waiting on you.</div>
            ) : null}
          </ListCard>
        </section>

        <section aria-labelledby="live-activity">
          <h2 id="live-activity" className="mb-2 text-sm font-semibold">
            Live activity & AI actions
          </h2>
          {workspaceRuns && pipelineRuns && workspaceReports ? (
            <ActivityFeed runs={workspaceRuns} pipelineRuns={pipelineRuns} reports={workspaceReports} />
          ) : (
            <ListCard>
              <RowsSkeleton rows={5} />
            </ListCard>
          )}
        </section>
      </div>
    </Page>
  );
}

// ---------- module widgets --------------------------------------------------------

/**
 * The `dashboard.widgets` slot: other modules (e.g. operate's token-burn chart)
 * render their own dashboard sections here — inversion of control, so this
 * module never imports theirs. Each contribution is gated on its own permission.
 */
function DashboardSlots(): React.JSX.Element | null {
  const kernel = useKernel();
  const { can } = useAuth();
  const widgets = kernel.slots('dashboard.widgets').filter((s) => s.permission === undefined || can(s.permission));
  if (widgets.length === 0) return null;
  return (
    <>
      {widgets.map((s) => (
        <s.component key={s.key} />
      ))}
    </>
  );
}

// ---------- live activity ---------------------------------------------------------

interface ActivityEntry {
  readonly id: string;
  readonly ts: number;
  readonly live: boolean;
  readonly status: string;
  readonly tone: StatusTone;
  readonly label: string;
  readonly href: string;
}

const RUN_KIND_LABEL: Record<RunListRecord['kind'], string> = {
  interactive: 'chat',
  triage: 'AI triage',
  fix: 'AI fix',
  analysis: 'AI analysis',
  implement: 'AI implement',
  report: 'AI report',
  assistant: 'AI Help',
  // Never appears in this feed (a command creates no run row), but the union is
  // exhaustive and a missing key would be a compile error the next time it moves.
  command: 'command',
};

function ActivityFeed({
  runs,
  pipelineRuns,
  reports,
}: {
  runs: RunListRecord[];
  pipelineRuns: PipelineRunRecord[];
  reports: ReportRecord[];
}): React.JSX.Element {
  const entries: ActivityEntry[] = [
    ...runs.map(
      (r): ActivityEntry => ({
        id: `run-${r.id}`,
        ts: r.updatedAt,
        live: r.live,
        status: `${r.live ? 'live' : r.status} · ${RUN_KIND_LABEL[r.kind]}`,
        tone:
          r.status === 'failed' || r.status === 'interrupted'
            ? 'red'
            : r.status === 'completed'
              ? 'green'
              : r.status === 'review'
                ? 'amber'
                : 'zinc',
        label: r.title,
        href: runHref(r),
      }),
    ),
    ...pipelineRuns.map(
      (p): ActivityEntry => ({
        id: `plr-${p.id}`,
        ts: p.finishedAt ?? p.createdAt,
        live: p.status === 'running',
        status: `${p.status} · pipeline on ${p.target === 'platform' ? p.repo.split('/')[1] : `${p.target === 'issue' ? 'issue' : 'PR'} #${p.prNumber}`}`,
        tone: p.status === 'failed' || p.status === 'error' ? 'red' : p.status === 'passed' ? 'green' : 'zinc',
        label: p.pipelineName,
        href: pipelineRunHref(p),
      }),
    ),
    ...reports.map(
      (r): ActivityEntry => ({
        id: `rep-${r.id}`,
        ts: r.createdAt,
        live: false,
        status: `report · ${r.kind}`,
        tone: 'zinc',
        label: r.title,
        href: reportHref(r),
      }),
    ),
  ]
    .sort((a, b) => Number(b.live) - Number(a.live) || b.ts - a.ts)
    .slice(0, 12);

  return (
    <ListCard>
      {entries.map((e) => (
        <a key={e.id} href={e.href} className="row-link anim-in">
          {e.live ? <Spinner /> : <StatusDot tone={e.tone} />}
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{e.label}</span>
            <span className="dim block truncate text-xs">{e.status}</span>
          </span>
          <span className="dim shrink-0">{timeAgo(e.ts)}</span>
        </a>
      ))}
      {entries.length === 0 ? (
        <div className="dim px-4 py-6 text-center text-sm">No activity yet — AI actions land here as they run.</div>
      ) : null}
    </ListCard>
  );
}

// ---------- agent usage ----------------------------------------------------------

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/**
 * Sessions + token spend for this workspace. The gateway does not report money,
 * so tokens are the cost proxy; per-session bars use dataviz sequential slot 1.
 */
function UsageSection({ runs }: { runs: RunListRecord[] | null }): React.JSX.Element | null {
  if (runs === null) {
    return (
      <section className="mt-6" aria-labelledby="usage-heading" aria-busy>
        <h2 id="usage-heading" className="mb-2 text-sm font-semibold">
          Agent usage
        </h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatTile label="Sessions" loading value={0} />
          <StatTile label="Tokens in" loading value={0} />
          <StatTile label="Tokens out" loading value={0} />
          <StatTile label="Avg tokens / session" loading value={0} />
        </div>
        <div className="mt-3">
          <ChartSkeleton title="Tokens per session" />
        </div>
      </section>
    );
  }
  if (runs.length === 0) return null;
  const totalIn = runs.reduce((acc, r) => acc + r.inputTokens, 0);
  const totalOut = runs.reduce((acc, r) => acc + r.outputTokens, 0);
  const live = runs.filter((r) => r.live).length;
  const avg = Math.round((totalIn + totalOut) / runs.length);
  const recent = [...runs].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10);
  const max = Math.max(1, ...recent.map((r) => r.inputTokens + r.outputTokens));

  return (
    <section className="mt-6" aria-labelledby="usage-heading">
      <h2 id="usage-heading" className="mb-2 text-sm font-semibold">
        Agent usage
      </h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Sessions" value={runs.length} hint={live > 0 ? `${live} live now` : 'none live'} href="#/runs" />
        <StatTile label="Tokens in" value={formatTokens(totalIn)} hint="prompt tokens, all sessions" />
        <StatTile label="Tokens out" value={formatTokens(totalOut)} hint="completion tokens, all sessions" />
        <StatTile label="Avg tokens / session" value={formatTokens(avg)} hint="cost proxy — spend is not reported" />
      </div>

      <figure className="card mt-3">
        <figcaption className="text-[13px] font-medium">Tokens per session — {recent.length} most recent</figcaption>
        <div className="mt-2.5 flex flex-col gap-1">
          {recent.map((r) => {
            const t = r.inputTokens + r.outputTokens;
            return (
              <a
                key={r.id}
                href={`#/runs/${r.id}`}
                className="group flex items-center gap-2.5 rounded-md px-1 py-0.5 text-[13px] transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900"
                title={`${r.title} — ${t.toLocaleString()} tokens (${r.inputTokens.toLocaleString()} in / ${r.outputTokens.toLocaleString()} out)`}
              >
                <span className="dim w-36 shrink-0 truncate group-hover:text-zinc-800 dark:group-hover:text-zinc-200">
                  {r.title}
                </span>
                <span className="h-2.5 flex-1 overflow-hidden rounded-sm bg-zinc-100 dark:bg-zinc-800">
                  <span
                    className="block h-full rounded-sm bg-[#2a78d6] dark:bg-[#3987e5]"
                    style={{ width: `${Math.max(1, (t / max) * 100)}%` }}
                  />
                </span>
                <span className="dim w-14 shrink-0 text-right tabular-nums">{formatTokens(t)}</span>
              </a>
            );
          })}
        </div>
      </figure>
    </section>
  );
}

// ---------- metrics --------------------------------------------------------------

// Two-series categorical palette (dataviz slots 1+2), validated per mode on the
// app surfaces; the light aqua sits below 3:1 so the data-table view is the relief.
const OPENED = 'fill-[#2a78d6] dark:fill-[#3987e5]';
const CLOSED = 'fill-[#1baf7a] dark:fill-[#199e70]';
const OPENED_SWATCH = 'bg-[#2a78d6] dark:bg-[#3987e5]';
const CLOSED_SWATCH = 'bg-[#1baf7a] dark:bg-[#199e70]';

function MetricsSection({ metrics }: { metrics: WorkspaceMetrics | null }): React.JSX.Element {
  if (metrics === null) {
    return (
      <section className="mt-6" aria-labelledby="metrics-heading" aria-busy>
        <h2 id="metrics-heading" className="mb-2 text-sm font-semibold">
          Velocity
        </h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatTile label="Issues opened · 7d" loading value={0} />
          <StatTile label="Issues closed · 7d" loading value={0} />
          <StatTile label="PRs opened · 7d" loading value={0} />
          <StatTile label="PRs closed · 7d" loading value={0} />
        </div>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <ChartSkeleton title="Issues — opened vs closed by week" />
          <ChartSkeleton title="Pull requests — opened vs closed by week" />
        </div>
      </section>
    );
  }
  const weekly = metrics.weekly;
  // Rolling 7-day deltas: immune to the partial-calendar-week distortion.
  const rolling = (current: number, previous: number, upIsGood: boolean) => ({
    current,
    previous,
    period: 'vs prior 7 days',
    upIsGood,
  });

  return (
    <section className="mt-6" aria-labelledby="metrics-heading">
      <h2 id="metrics-heading" className="mb-2 text-sm font-semibold">
        Velocity
      </h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile
          label="Issues opened · 7d"
          value={metrics.issuesOpened7d}
          delta={rolling(metrics.issuesOpened7d, metrics.issuesOpenedPrev7d, false)}
          trend={weekly.map((w) => w.issuesOpened)}
          hint={`${metrics.openIssues} open · ${metrics.closedIssues} closed all-time`}
        />
        <StatTile
          label="Issues closed · 7d"
          value={metrics.issuesClosed7d}
          tone={metrics.issuesClosed7d >= metrics.issuesOpened7d ? 'ok' : 'warn'}
          delta={rolling(metrics.issuesClosed7d, metrics.issuesClosedPrev7d, true)}
          trend={weekly.map((w) => w.issuesClosed)}
          hint={
            metrics.issuesClosed7d >= metrics.issuesOpened7d ? 'keeping up with intake' : 'intake outpacing closes'
          }
        />
        <StatTile
          label="PRs opened · 7d"
          value={metrics.prsOpened7d}
          delta={rolling(metrics.prsOpened7d, metrics.prsOpenedPrev7d, true)}
          trend={weekly.map((w) => w.prsOpened)}
          hint={`${metrics.openPrs} open · ${metrics.mergedPrs} merged all-time`}
        />
        <StatTile
          label="PRs closed · 7d"
          value={metrics.prsClosed7d}
          tone={metrics.prsClosed7d >= metrics.prsOpened7d ? 'ok' : 'warn'}
          delta={rolling(metrics.prsClosed7d, metrics.prsClosedPrev7d, true)}
          trend={weekly.map((w) => w.prsClosed)}
          hint="merged or closed"
        />
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <VelocityChart
          title="Issues — opened vs closed by week"
          weekly={metrics.weekly}
          opened={(w) => w.issuesOpened}
          closed={(w) => w.issuesClosed}
        />
        <VelocityChart
          title="Pull requests — opened vs closed by week"
          weekly={metrics.weekly}
          opened={(w) => w.prsOpened}
          closed={(w) => w.prsClosed}
        />
      </div>
    </section>
  );
}

function VelocityChart({
  title,
  weekly,
  opened,
  closed,
}: {
  title: string;
  weekly: ReadonlyArray<WeeklyCounts>;
  opened: (w: WeeklyCounts) => number;
  closed: (w: WeeklyCounts) => number;
}): React.JSX.Element {
  const [hover, setHover] = useState<number | null>(null);
  const width = 520;
  const height = 150;
  const pad = { top: 8, right: 8, bottom: 22, left: 26 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const max = Math.max(1, ...weekly.flatMap((w) => [opened(w), closed(w)]));
  const groupW = plotW / weekly.length;
  const barW = Math.min(14, (groupW - 8) / 2);
  const y = (v: number): number => pad.top + plotH - (v / max) * plotH;
  const weekLabel = (ts: number): string =>
    new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

  return (
    <figure className="card">
      <figcaption className="flex flex-wrap items-center gap-3 text-[13px] font-medium">
        {title}
        <span className="dim ml-auto flex items-center gap-3 font-normal" aria-hidden>
          <span className="flex items-center gap-1.5">
            <span className={`inline-block size-2.5 rounded-sm ${OPENED_SWATCH}`} />
            opened
          </span>
          <span className="flex items-center gap-1.5">
            <span className={`inline-block size-2.5 rounded-sm ${CLOSED_SWATCH}`} />
            closed
          </span>
        </span>
      </figcaption>
      <div className="relative">
        {hover !== null && weekly[hover] ? (
          <div
            className="pointer-events-none absolute -top-1 z-10 -translate-x-1/2 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs whitespace-nowrap shadow-md dark:border-zinc-700 dark:bg-zinc-900"
            style={{ left: `${((pad.left + hover * groupW + groupW / 2) / width) * 100}%` }}
            role="status"
          >
            <span className="font-medium">{weekLabel(weekly[hover]!.weekStart)}</span>
            <span className="dim ml-2">opened {opened(weekly[hover]!)}</span>
            <span className="dim ml-2">closed {closed(weekly[hover]!)}</span>
          </div>
        ) : null}
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="mt-1 w-full"
        role="img"
        aria-label={`${title}: weekly opened and closed counts for the last ${weekly.length} weeks`}
        onMouseLeave={() => setHover(null)}
      >
        {(max >= 2 ? [0.5, 1] : [1]).map((f) => (
          <g key={f}>
            <line
              x1={pad.left}
              x2={width - pad.right}
              y1={y(max * f)}
              y2={y(max * f)}
              className="stroke-zinc-200 dark:stroke-zinc-800"
              strokeWidth={1}
            />
            <text
              x={pad.left - 5}
              y={y(max * f) + 3}
              textAnchor="end"
              className="fill-zinc-400 text-[9px] tabular-nums dark:fill-zinc-500"
            >
              {Math.round(max * f)}
            </text>
          </g>
        ))}
        <line
          x1={pad.left}
          x2={width - pad.right}
          y1={pad.top + plotH}
          y2={pad.top + plotH}
          className="stroke-zinc-300 dark:stroke-zinc-700"
          strokeWidth={1}
        />
        {weekly.map((w, i) => {
          const cx = pad.left + i * groupW + groupW / 2;
          const o = opened(w);
          const c = closed(w);
          return (
            <g key={w.weekStart} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              {/* full-column hit target so hover works between the thin bars */}
              <rect
                x={pad.left + i * groupW}
                y={pad.top}
                width={groupW}
                height={plotH}
                fill="transparent"
                className={hover === i ? 'fill-zinc-500/10' : ''}
              />
              <rect
                x={cx - barW - 1}
                y={y(o)}
                width={barW}
                height={Math.max(0, pad.top + plotH - y(o))}
                rx={2}
                className={OPENED}
                pointerEvents="none"
              />
              <rect
                x={cx + 1}
                y={y(c)}
                width={barW}
                height={Math.max(0, pad.top + plotH - y(c))}
                rx={2}
                className={CLOSED}
                pointerEvents="none"
              />
              <text
                x={cx}
                y={height - 8}
                textAnchor="middle"
                className="fill-zinc-400 text-[9px] dark:fill-zinc-500"
              >
                {weekLabel(w.weekStart)}
              </text>
            </g>
          );
        })}
      </svg>
      </div>
      <details className="mt-1">
        <summary className="dim cursor-pointer text-xs">data table</summary>
        <table className="mt-1.5 w-full text-left text-xs">
          <thead>
            <tr className="dim">
              <th className="py-0.5 font-normal">Week</th>
              <th className="py-0.5 font-normal">Opened</th>
              <th className="py-0.5 font-normal">Closed</th>
            </tr>
          </thead>
          <tbody>
            {weekly.map((w) => (
              <tr key={w.weekStart}>
                <td className="py-0.5">{weekLabel(w.weekStart)}</td>
                <td className="py-0.5 tabular-nums">{opened(w)}</td>
                <td className="py-0.5 tabular-nums">{closed(w)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
