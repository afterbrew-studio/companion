import type { AuthUser, ServiceMap } from '@moxxy/companion-contracts';
import type { IssueListRecord, PrListRecord } from '@companion/module-code/contract';
import type { RunListRecord } from '@companion/module-operate/contract';
import type { BoardConfig, TaskListRecord } from '@companion/module-board/contract';
import type { DecisionItem, DecisionSnapshot } from '../contract/index.js';
import type { WorkbenchActions } from './workbench-actions.js';

type WorkspaceService = ServiceMap['workspace'];
type OperateService = ServiceMap['operate'];
type CodeService = ServiceMap['code'];
type BoardService = ServiceMap['board'];

const SOURCE_LIMIT = 100;
const SNAPSHOT_LIMIT = 200;

interface DecisionSources {
  readonly workspaceId: string;
  readonly tasks: readonly TaskListRecord[];
  readonly boardConfig: BoardConfig | null;
  readonly runs: readonly RunListRecord[];
  readonly prs: readonly PrListRecord[];
  readonly issues: readonly IssueListRecord[];
}

interface DecisionPermissions {
  readonly board: boolean;
  readonly runs: boolean;
  readonly prs: boolean;
  readonly issues: boolean;
}

/**
 * Read-only composition over domain services. Workbench owns neither rows nor
 * actions: it finds what is waiting, deduplicates by the durable Board links,
 * and sends the user back to the owning detail surface.
 */
export class WorkbenchService {
  constructor(
    readonly actions: WorkbenchActions,
    private readonly workspace: WorkspaceService,
    private readonly operate: OperateService,
    private readonly code: CodeService,
    private readonly board: () => BoardService | undefined,
    private readonly permissions: (user: AuthUser) => DecisionPermissions,
  ) {}

  async decisions(user: AuthUser, workspaceId: string): Promise<DecisionSnapshot> {
    this.workspace.requireAccessible(user, workspaceId);
    const repoNames = this.workspace.repoNames(workspaceId);
    const permissions = this.permissions(user);

    const runPage = permissions.runs
      ? this.operate.orchestrator.listRunsPage({
          userId: user.username,
          repoNames,
          status: 'review',
          limit: SOURCE_LIMIT,
        })
      : { runs: [], total: 0 };

    const canReadPrs = permissions.prs;
    const canReadIssues = permissions.issues;
    const accessibleRepos = canReadPrs || canReadIssues
      ? await this.code.accessibleRepoNames(user.username, workspaceId)
      : [];
    const prPage = canReadPrs
      ? this.code.prs.listWorkspacePaged(workspaceId, 'open', {
          review: 'pending',
          accessibleRepos,
          includeFacets: false,
          limit: SOURCE_LIMIT,
        })
      : { prs: [], total: 0 };
    const issuePage = canReadIssues
      ? this.code.issues.listWorkspacePaged(workspaceId, 'open', {
          triage: 'pending',
          accessibleRepos,
          includeFacets: false,
          limit: SOURCE_LIMIT,
        })
      : { issues: [], total: 0 };
    const board = permissions.board ? this.board() : undefined;
    const boardSnapshot = board?.listDecisionContext(
      user,
      workspaceId,
      {
        runIds: runPage.runs.map((run) => run.id),
        pullRequests: prPage.prs.map((pr) => ({ repo: pr.repo, number: pr.number })),
      },
      SNAPSHOT_LIMIT,
    ) ?? null;

    const items = buildDecisionItems({
      workspaceId,
      tasks: boardSnapshot?.tasks ?? [],
      boardConfig: boardSnapshot?.config ?? null,
      runs: runPage.runs,
      prs: prPage.prs,
      issues: issuePage.issues,
    });

    return {
      items: items.slice(0, SNAPSHOT_LIMIT),
      hasMore:
        items.length > SNAPSHOT_LIMIT ||
        (boardSnapshot?.hasMore ?? false) ||
        runPage.total > runPage.runs.length ||
        prPage.total > prPage.prs.length ||
        issuePage.total > issuePage.issues.length,
    };
  }
}

/** Pure projection kept separate so ordering and cross-domain deduplication are testable. */
export function buildDecisionItems(sources: DecisionSources): DecisionItem[] {
  const activeTasks = sources.tasks.filter((task) => task.status !== 'done');
  const pendingPrs = new Set(sources.prs.map((pr) => `${pr.repo}#${pr.number}`));
  const managedRuns = new Set(activeTasks.flatMap((task) => (task.runId ? [task.runId] : [])));
  const managedPrs = new Set(
    activeTasks.flatMap((task) => {
      if (task.prNumber === null) return [];
      const key = `${task.repo}#${task.prNumber}`;
      // A pending result at Board's merge gate means publishing that review
      // still needs a person. Let that decision complete before offering merge.
      if (task.status === 'in_review' && task.stage === 'awaiting_merge' && pendingPrs.has(key)) return [];
      return [key];
    }),
  );

  const items: DecisionItem[] = [];
  if (sources.boardConfig) {
    for (const task of activeTasks) {
      if (task.status === 'failed') {
        const failure = task.lastError?.trim().slice(0, 240);
        items.push({
          id: `board:${task.id}:failure`,
          workspaceId: sources.workspaceId,
          kind: 'board-failure',
          subject: { type: 'task', id: task.id, repo: task.repo },
          title: task.title,
          reason: failure
            ? `Automation stopped after ${task.attempts} attempt${task.attempts === 1 ? '' : 's'}: ${failure}`
            : `Automation stopped after ${task.attempts} attempt${task.attempts === 1 ? '' : 's'}.`,
          nextAction: 'Resolve task',
          href: `#/board?task=${encodeURIComponent(task.id)}`,
          updatedAt: task.updatedAt,
        });
        continue;
      }
      const pendingReview =
        task.prNumber !== null && pendingPrs.has(`${task.repo}#${task.prNumber}`);
      const autoMerge = task.automationPolicy?.autoMerge ?? sources.boardConfig.autoMerge;
      if (pendingReview || !needsBoardDecision(task, autoMerge)) continue;
      items.push({
        id: `board:${task.id}:merge`,
        workspaceId: sources.workspaceId,
        kind: 'board-merge',
        subject: { type: 'task', id: task.id, repo: task.repo },
        title: task.title,
        reason: boardDecisionReason(task),
        nextAction: 'Decide task',
        href: `#/board?task=${encodeURIComponent(task.id)}`,
        updatedAt: task.updatedAt,
      });
    }
  }

  for (const run of sources.runs) {
    if (managedRuns.has(run.id)) continue;
    items.push({
      id: `run:${run.id}:review`,
      workspaceId: sources.workspaceId,
      kind: 'agent-change',
      subject: { type: 'run', id: run.id, repo: run.repo },
      title: run.title,
      reason: 'The agent finished a change and is waiting for approval.',
      nextAction: 'Review change',
      href: `#/runs/${encodeURIComponent(run.id)}/preview`,
      updatedAt: run.updatedAt,
    });
  }

  for (const pr of sources.prs) {
    if (managedPrs.has(`${pr.repo}#${pr.number}`)) continue;
    items.push({
      id: `pr:${pr.repo}#${pr.number}:review`,
      workspaceId: sources.workspaceId,
      kind: 'pull-request-review',
      subject: { type: 'pull-request', repo: pr.repo, number: pr.number },
      title: pr.title,
      reason: pr.reviewRisk
        ? `The AI review is ready with ${pr.reviewRisk} risk; nothing has been posted to GitHub.`
        : 'The AI review is ready; nothing has been posted to GitHub.',
      nextAction: 'Review findings',
      href: `#/repos/${pr.repo}/prs/${pr.number}/review`,
      updatedAt: pr.updatedAt,
    });
  }

  for (const issue of sources.issues) {
    items.push({
      id: `issue:${issue.repo}#${issue.number}:triage`,
      workspaceId: sources.workspaceId,
      kind: 'issue-triage',
      subject: { type: 'issue', repo: issue.repo, number: issue.number },
      title: issue.title,
      reason: 'AI triage is ready; no labels or reply have been applied.',
      nextAction: 'Review triage',
      href: `#/repos/${issue.repo}/issues/${issue.number}`,
      updatedAt: issue.updatedAt,
    });
  }

  return items.sort((a, b) => priorityOf(a) - priorityOf(b) || a.updatedAt - b.updatedAt || a.id.localeCompare(b.id));
}

function needsBoardDecision(task: TaskListRecord, autoMerge: boolean): boolean {
  return (
    task.status === 'in_review' &&
    task.stage === 'awaiting_merge' &&
    !(autoMerge && task.reviewRecommendation === 'approve' && task.reviewRisk === 'low')
  );
}

function boardDecisionReason(task: TaskListRecord): string {
  if (task.reviewRecommendation === 'request_changes') {
    return 'The review recommends changes. Decide whether to requeue the task or merge it.';
  }
  if (task.reviewRecommendation === 'comment') {
    return 'The review has non-blocking notes. Decide whether the pull request should merge.';
  }
  if (task.reviewRecommendation === 'approve') {
    return task.reviewRisk === 'low'
      ? 'The review passed with low risk, but automatic merge is off.'
      : `The review approves the change with ${task.reviewRisk ?? 'unknown'} risk; merging needs a human decision.`;
  }
  return 'The task reached the merge gate without a clear recommendation.';
}

function priorityOf(item: DecisionItem): number {
  switch (item.kind) {
    case 'board-failure':
      return 0;
    case 'board-merge':
      return 1;
    case 'agent-change':
      return 2;
    case 'pull-request-review':
      return 3;
    case 'issue-triage':
      return 4;
  }
}
