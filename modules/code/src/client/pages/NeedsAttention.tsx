import type { ReactNode } from 'react';
import { useModuleEnabled } from '@moxxy/companion-sdk/client';
import { EmptyState, ErrorBar, ListCard, Page, PageHeader, RowsSkeleton, StatusDot, timeAgo } from '@moxxy/companion-sdk/ui';
import type { PrListRecord } from '../../contract/index.js';
import { useOverview } from '../hooks/useOverview.js';
import { ChecksIcon } from '../widgets.js';

/** A pull request nobody has touched for this long is waiting on someone. */
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Everything in this workspace that is waiting on a human, in full.
 *
 * The Overview shows the same queues, but capped and beside four other
 * sections — enough to notice a backlog, not enough to work through one. This
 * page is the whole of each queue, grouped by what the reader would do next.
 * It reads the Overview's feeds rather than adding its own: every item here is
 * already on the wire for the dashboard.
 */
export function NeedsAttentionPage(): JSX.Element {
  const o = useOverview();
  const planEnabled = useModuleEnabled('plan');

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

  // Both derive from the open-PR list the Overview already holds, so they cost
  // no request — and a PR can be stale AND unassigned, which is one row in each
  // group on purpose: they are two different things to do about it.
  const openPrs = o.openPrs;
  const unassigned = openPrs?.filter((pr) => pr.assignees.length === 0 && !pr.draft) ?? null;
  const stale = openPrs?.filter((pr) => Date.now() - pr.updatedAt > STALE_MS && !pr.draft) ?? null;

  const loading = o.attentionCount === null;
  const nothing =
    o.attentionCount === 0 && (unassigned?.length ?? 0) === 0 && (stale?.length ?? 0) === 0;

  return (
    <Page>
      <PageHeader
        title="Needs attention"
        subtitle={o.workspaceName}
      />
      <ErrorBar error={o.error} />

      {loading ? (
        <ListCard>
          <RowsSkeleton rows={6} />
        </ListCard>
      ) : nothing ? (
        <EmptyState title="Nothing waiting on you" hint="Every queue in this workspace is clear." />
      ) : (
        <div className="flex flex-col gap-5">
          <Group title="Agent runs awaiting review" count={o.reviewRuns?.length ?? 0}>
            {o.reviewRuns?.map((run) => (
              <Row
                key={run.id}
                href={`#/runs/${run.id}/preview`}
                title={run.title}
                detail="the agent finished — open the change it proposes"
                at={run.updatedAt}
              />
            ))}
          </Group>

          <Group title="AI reviews awaiting your decision" count={o.prReviewsPending?.length ?? 0}>
            {o.prReviewsPending?.map((pr) => (
              <Row
                key={`rev-${pr.repo}#${pr.number}`}
                href={`#/repos/${pr.repo}/prs/${pr.number}/review`}
                title={pr.title}
                detail={where(pr)}
                at={pr.updatedAt}
              />
            ))}
          </Group>

          <Group title="Triage awaiting your decision" count={o.triagePending?.length ?? 0}>
            {o.triagePending?.map((issue) => (
              <Row
                key={`tri-${issue.repo}#${issue.number}`}
                href={`#/repos/${issue.repo}/issues/${issue.number}`}
                title={issue.title}
                detail={`#${issue.number} · ${repoName(issue.repo)}`}
                at={issue.updatedAt}
              />
            ))}
          </Group>

          <Group title="Failing CI" count={o.failingPrs?.length ?? 0}>
            {o.failingPrs?.map((pr) => (
              <Row
                key={`ci-${pr.repo}#${pr.number}`}
                href={`#/repos/${pr.repo}/prs/${pr.number}`}
                title={pr.title}
                detail={where(pr)}
                at={pr.updatedAt}
                icon={<ChecksIcon checks={pr.checks} />}
              />
            ))}
          </Group>

          <Group title="Unassigned pull requests" count={unassigned?.length ?? 0}>
            {unassigned?.map((pr) => (
              <Row
                key={`un-${pr.repo}#${pr.number}`}
                href={`#/repos/${pr.repo}/prs/${pr.number}`}
                title={pr.title}
                detail={where(pr)}
                at={pr.updatedAt}
              />
            ))}
          </Group>

          <Group title="No movement in a week" count={stale?.length ?? 0}>
            {stale?.map((pr) => (
              <Row
                key={`st-${pr.repo}#${pr.number}`}
                href={`#/repos/${pr.repo}/prs/${pr.number}`}
                title={pr.title}
                detail={where(pr)}
                at={pr.updatedAt}
              />
            ))}
          </Group>

          {planEnabled ? (
            <Group title="Legacy proposals" count={o.actionableProposals?.length ?? 0}>
              {o.actionableProposals?.map((p) => (
                <Row
                  key={p.id}
                  href="#/legacy-proposals"
                  title={p.title}
                  detail={p.status === 'review' ? 'ready for review' : 'awaiting approval'}
                  at={p.updatedAt}
                />
              ))}
            </Group>
          ) : null}
        </div>
      )}
    </Page>
  );
}

const repoName = (repo: string): string => repo.split('/')[1] ?? repo;
const where = (pr: PrListRecord): string => `#${pr.number} · ${repoName(pr.repo)}`;

/** A queue, or nothing at all — an empty group is not news, it is noise. */
function Group({ title, count, children }: { title: string; count: number; children: ReactNode }): JSX.Element | null {
  if (count === 0) return null;
  return (
    <section>
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        {title}
        <span className="dim text-xs font-normal">{count}</span>
      </h2>
      <ListCard>{children}</ListCard>
    </section>
  );
}

function Row({
  href,
  title,
  detail,
  at,
  icon,
}: {
  href: string;
  title: string;
  detail: string;
  at: number;
  icon?: ReactNode;
}): JSX.Element {
  return (
    <a href={href} className="row-link">
      {icon ?? <StatusDot tone="amber" />}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{title}</span>
        <span className="dim block truncate text-xs">{detail}</span>
      </span>
      <span className="dim shrink-0">{timeAgo(at)}</span>
    </a>
  );
}
