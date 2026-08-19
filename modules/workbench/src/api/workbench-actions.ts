import { createHash, randomUUID } from 'node:crypto';
import type { AuthUser, ServiceMap } from '@moxxy/companion-contracts';
import { badRequest, notFound } from '@moxxy/companion-sdk/server';
import { buildAnchorIndex, checkAnchor, unifiedDiffFromPatches } from '@companion/module-code/contract';
import type {
  DecisionSubject,
  PreparedWorkbenchAction,
  WorkbenchActionDefinition,
  WorkbenchActionId,
  WorkbenchActionRequest,
  WorkbenchActionResult,
  WorkbenchActionSource,
} from '../contract/index.js';
import { WorkbenchActionsStore, type StoredWorkbenchAction } from './workbench-actions-store.js';

type WorkspaceService = ServiceMap['workspace'];
type OperateService = ServiceMap['operate'];
type CodeService = ServiceMap['code'];
type BoardService = ServiceMap['board'];
type PlanService = ServiceMap['plan'];

const ACTION_TTL_MS = 30 * 60_000;
const MAX_PENDING_ACTIONS = 25;

export const WORKBENCH_ACTIONS: readonly WorkbenchActionDefinition[] = [
  {
    id: 'run.approve',
    title: 'Publish agent change',
    description: 'Commit and push the reviewed run, opening a pull request when needed.',
    access: ['workbench:read', 'runs:read', 'runs:act'],
    impact: 'external',
    arguments: [
      argument('runId', 'string', true, 'Agent run id'),
      argument('title', 'string', false, 'Optional pull-request title'),
      argument('body', 'string', false, 'Optional pull-request body'),
    ],
  },
  {
    id: 'run.discard',
    title: 'Discard agent change',
    description: 'Abandon the run and remove its isolated worktree.',
    access: ['workbench:read', 'runs:read', 'runs:act'],
    impact: 'destructive',
    arguments: [argument('runId', 'string', true, 'Agent run id')],
  },
  {
    id: 'pr-review.apply',
    title: 'Publish AI review',
    description: 'Post the selected AI review evidence to GitHub.',
    access: ['workbench:read', 'prs:read', 'prs:act'],
    impact: 'external',
    arguments: [
      argument('repo', 'string', true, 'Repository as owner/name'),
      argument('number', 'integer', true, 'Pull-request number'),
      argument('mode', 'string', false, 'Review publication mode', ['full', 'comments', 'summary']),
    ],
  },
  {
    id: 'pr-review.dismiss',
    title: 'Dismiss AI review',
    description: 'Dismiss the pending result without writing to GitHub.',
    access: ['workbench:read', 'prs:read', 'prs:act'],
    impact: 'local',
    arguments: [
      argument('repo', 'string', true, 'Repository as owner/name'),
      argument('number', 'integer', true, 'Pull-request number'),
    ],
  },
  {
    id: 'pr.comment',
    title: 'Comment on pull request',
    description: 'Post reviewed Markdown to a pull-request conversation on GitHub.',
    access: ['workbench:read', 'prs:read', 'prs:act'],
    impact: 'external',
    arguments: [
      argument('repo', 'string', true, 'Repository as owner/name'),
      argument('number', 'integer', true, 'Pull-request number'),
      argument('body', 'string', true, 'Complete Markdown comment body'),
    ],
  },
  {
    id: 'pr.review-comment.reply',
    title: 'Reply in pull-request review thread',
    description: 'Post reviewed Markdown as a reply to one exact inline review comment.',
    access: ['workbench:read', 'prs:read', 'prs:act'],
    impact: 'external',
    arguments: [
      argument('repo', 'string', true, 'Repository as owner/name'),
      argument('number', 'integer', true, 'Pull-request number'),
      argument('commentId', 'integer', true, 'GitHub review comment database id'),
      argument('body', 'string', true, 'Complete Markdown reply body'),
    ],
  },
  {
    id: 'pr.review-comment.create',
    title: 'Comment on a pull-request line',
    description: 'Post reviewed Markdown and an optional GitHub suggestion on an exact diff line or range.',
    access: ['workbench:read', 'prs:read', 'prs:act'],
    impact: 'external',
    arguments: [
      argument('repo', 'string', true, 'Repository as owner/name'),
      argument('number', 'integer', true, 'Pull-request number'),
      argument('path', 'string', true, 'Changed file path'),
      argument('side', 'string', true, 'Diff side', ['LEFT', 'RIGHT']),
      argument('line', 'integer', true, 'Last line of the diff range'),
      argument('startLine', 'integer', false, 'Optional first line of the diff range'),
      argument('quotedLine', 'string', true, 'Exact text at the final anchored line'),
      argument('body', 'string', true, 'Complete Markdown comment body'),
      argument('suggestion', 'string', false, 'Optional exact replacement text for the selected range'),
    ],
  },
  {
    id: 'pr.review-thread.resolve',
    title: 'Resolve pull-request review thread',
    description: 'Mark one exact, currently unresolved GitHub review thread as resolved.',
    access: ['workbench:read', 'prs:read', 'prs:act'],
    impact: 'external',
    arguments: [
      argument('repo', 'string', true, 'Repository as owner/name'),
      argument('number', 'integer', true, 'Pull-request number'),
      argument('threadId', 'string', true, 'GitHub GraphQL review thread id'),
    ],
  },
  {
    id: 'pr.labels.add',
    title: 'Add pull-request labels',
    description: 'Add reviewed labels without removing labels already present on GitHub.',
    access: ['workbench:read', 'prs:read', 'prs:act'],
    impact: 'external',
    arguments: [
      argument('repo', 'string', true, 'Repository as owner/name'),
      argument('number', 'integer', true, 'Pull-request number'),
      argument('labels', 'string[]', true, 'Labels to add'),
    ],
  },
  {
    id: 'pr.labels.remove',
    title: 'Remove pull-request labels',
    description: 'Remove reviewed labels currently present on a pull request.',
    access: ['workbench:read', 'prs:read', 'prs:act'],
    impact: 'external',
    arguments: [
      argument('repo', 'string', true, 'Repository as owner/name'),
      argument('number', 'integer', true, 'Pull-request number'),
      argument('labels', 'string[]', true, 'Labels to remove'),
    ],
  },
  {
    id: 'pr.reviewers.request',
    title: 'Request pull-request reviewers',
    description: 'Request one or more GitHub users to review a pull request.',
    access: ['workbench:read', 'prs:read', 'prs:act'],
    impact: 'external',
    arguments: [
      argument('repo', 'string', true, 'Repository as owner/name'),
      argument('number', 'integer', true, 'Pull-request number'),
      argument('reviewers', 'string[]', true, 'GitHub logins to request'),
    ],
  },
  {
    id: 'pr.reviewers.remove',
    title: 'Remove requested pull-request reviewers',
    description: 'Remove one or more outstanding GitHub review requests.',
    access: ['workbench:read', 'prs:read', 'prs:act'],
    impact: 'external',
    arguments: [
      argument('repo', 'string', true, 'Repository as owner/name'),
      argument('number', 'integer', true, 'Pull-request number'),
      argument('reviewers', 'string[]', true, 'Requested reviewer logins to remove'),
    ],
  },
  {
    id: 'pr.assignees.add',
    title: 'Assign pull request',
    description: 'Add one or more GitHub assignees to a pull request.',
    access: ['workbench:read', 'prs:read', 'prs:act'],
    impact: 'external',
    arguments: [
      argument('repo', 'string', true, 'Repository as owner/name'),
      argument('number', 'integer', true, 'Pull-request number'),
      argument('assignees', 'string[]', true, 'GitHub logins to assign'),
    ],
  },
  {
    id: 'pr.assignees.remove',
    title: 'Unassign pull request',
    description: 'Remove one or more current GitHub assignees from a pull request.',
    access: ['workbench:read', 'prs:read', 'prs:act'],
    impact: 'external',
    arguments: [
      argument('repo', 'string', true, 'Repository as owner/name'),
      argument('number', 'integer', true, 'Pull-request number'),
      argument('assignees', 'string[]', true, 'Assigned GitHub logins to remove'),
    ],
  },
  {
    id: 'pr.review.submit',
    title: 'Submit pull-request review',
    description: 'Approve a pull request or request changes with an exact reviewed message.',
    access: ['workbench:read', 'prs:read', 'prs:act'],
    impact: 'external',
    arguments: [
      argument('repo', 'string', true, 'Repository as owner/name'),
      argument('number', 'integer', true, 'Pull-request number'),
      argument('verdict', 'string', true, 'Review verdict', ['approve', 'request_changes']),
      argument('body', 'string', true, 'Complete Markdown review body'),
    ],
  },
  {
    id: 'pr.checks.rerun',
    title: 'Re-run pull-request checks',
    description: 'Re-run failed jobs or all GitHub Actions workflow runs for the current head.',
    access: ['workbench:read', 'prs:read', 'prs:act'],
    impact: 'external',
    arguments: [
      argument('repo', 'string', true, 'Repository as owner/name'),
      argument('number', 'integer', true, 'Pull-request number'),
      argument('scope', 'string', true, 'Which jobs to re-run', ['failed', 'all']),
    ],
  },
  {
    id: 'pr.update-branch',
    title: 'Update pull-request branch',
    description: 'Ask GitHub to merge the current base branch into the pull-request head.',
    access: ['workbench:read', 'prs:read', 'prs:act'],
    impact: 'external',
    arguments: [
      argument('repo', 'string', true, 'Repository as owner/name'),
      argument('number', 'integer', true, 'Pull-request number'),
    ],
  },
  {
    id: 'pr.ready',
    title: 'Mark pull request ready',
    description: 'Move a draft pull request into review on GitHub.',
    access: ['workbench:read', 'prs:read', 'prs:act'],
    impact: 'external',
    arguments: [
      argument('repo', 'string', true, 'Repository as owner/name'),
      argument('number', 'integer', true, 'Pull-request number'),
    ],
  },
  {
    id: 'pr.close',
    title: 'Close pull request',
    description: 'Optionally post reviewed Markdown, then close an unmerged pull request.',
    access: ['workbench:read', 'prs:read', 'prs:act'],
    impact: 'external',
    arguments: [
      argument('repo', 'string', true, 'Repository as owner/name'),
      argument('number', 'integer', true, 'Pull-request number'),
      argument('comment', 'string', false, 'Optional Markdown comment posted before closing'),
    ],
  },
  {
    id: 'pr.reopen',
    title: 'Reopen pull request',
    description: 'Reopen a closed, unmerged pull request and optionally post reviewed Markdown.',
    access: ['workbench:read', 'prs:read', 'prs:act'],
    impact: 'external',
    arguments: [
      argument('repo', 'string', true, 'Repository as owner/name'),
      argument('number', 'integer', true, 'Pull-request number'),
      argument('comment', 'string', false, 'Optional Markdown comment posted after reopening'),
    ],
  },
  {
    id: 'pr.merge',
    title: 'Merge pull request',
    description: 'Merge the current reviewed pull-request head with the selected GitHub merge method.',
    access: ['workbench:read', 'prs:read', 'prs:act'],
    impact: 'external',
    arguments: [
      argument('repo', 'string', true, 'Repository as owner/name'),
      argument('number', 'integer', true, 'Pull-request number'),
      argument('method', 'string', true, 'Merge method', ['merge', 'squash', 'rebase']),
    ],
  },
  {
    id: 'issue-triage.apply',
    title: 'Apply issue triage',
    description: 'Apply proposed labels and optionally the draft reply on GitHub.',
    access: ['workbench:read', 'issues:read', 'issues:act'],
    impact: 'external',
    arguments: [
      argument('repo', 'string', true, 'Repository as owner/name'),
      argument('number', 'integer', true, 'Issue number'),
      argument('comment', 'boolean', false, 'Also post the proposed reply; defaults to false'),
    ],
  },
  {
    id: 'issue-triage.dismiss',
    title: 'Dismiss issue triage',
    description: 'Dismiss the pending result without writing to GitHub.',
    access: ['workbench:read', 'issues:read', 'issues:act'],
    impact: 'local',
    arguments: [
      argument('repo', 'string', true, 'Repository as owner/name'),
      argument('number', 'integer', true, 'Issue number'),
    ],
  },
  {
    id: 'issue.comment',
    title: 'Comment on issue',
    description: 'Post reviewed Markdown to an issue conversation on GitHub.',
    access: ['workbench:read', 'issues:read', 'issues:act'],
    impact: 'external',
    arguments: [
      argument('repo', 'string', true, 'Repository as owner/name'),
      argument('number', 'integer', true, 'Issue number'),
      argument('body', 'string', true, 'Complete Markdown comment body'),
    ],
  },
  {
    id: 'issue.close',
    title: 'Close issue',
    description: 'Optionally post reviewed Markdown, then close the issue on GitHub.',
    access: ['workbench:read', 'issues:read', 'issues:act'],
    impact: 'external',
    arguments: [
      argument('repo', 'string', true, 'Repository as owner/name'),
      argument('number', 'integer', true, 'Issue number'),
      argument('comment', 'string', false, 'Optional Markdown comment posted before closing'),
    ],
  },
  {
    id: 'issue.reopen',
    title: 'Reopen issue',
    description: 'Reopen a closed issue and optionally post reviewed Markdown.',
    access: ['workbench:read', 'issues:read', 'issues:act'],
    impact: 'external',
    arguments: [
      argument('repo', 'string', true, 'Repository as owner/name'),
      argument('number', 'integer', true, 'Issue number'),
      argument('comment', 'string', false, 'Optional Markdown comment posted after reopening'),
    ],
  },
  {
    id: 'issue.labels.add',
    title: 'Add issue labels',
    description: 'Add reviewed labels without removing labels already present on GitHub.',
    access: ['workbench:read', 'issues:read', 'issues:act'],
    impact: 'external',
    arguments: [
      argument('repo', 'string', true, 'Repository as owner/name'),
      argument('number', 'integer', true, 'Issue number'),
      argument('labels', 'string[]', true, 'Labels to add'),
    ],
  },
  {
    id: 'issue.labels.remove',
    title: 'Remove issue labels',
    description: 'Remove reviewed labels currently present on an issue.',
    access: ['workbench:read', 'issues:read', 'issues:act'],
    impact: 'external',
    arguments: [
      argument('repo', 'string', true, 'Repository as owner/name'),
      argument('number', 'integer', true, 'Issue number'),
      argument('labels', 'string[]', true, 'Labels to remove'),
    ],
  },
  {
    id: 'issue.assignees.add',
    title: 'Assign issue',
    description: 'Add one or more GitHub assignees to an issue.',
    access: ['workbench:read', 'issues:read', 'issues:act'],
    impact: 'external',
    arguments: [
      argument('repo', 'string', true, 'Repository as owner/name'),
      argument('number', 'integer', true, 'Issue number'),
      argument('assignees', 'string[]', true, 'GitHub logins to assign'),
    ],
  },
  {
    id: 'issue.assignees.remove',
    title: 'Unassign issue',
    description: 'Remove one or more current GitHub assignees from an issue.',
    access: ['workbench:read', 'issues:read', 'issues:act'],
    impact: 'external',
    arguments: [
      argument('repo', 'string', true, 'Repository as owner/name'),
      argument('number', 'integer', true, 'Issue number'),
      argument('assignees', 'string[]', true, 'Assigned GitHub logins to remove'),
    ],
  },
  {
    id: 'board.merge',
    title: 'Merge Board task',
    description: 'Merge the task pull request through the Board policy and complete the task.',
    access: ['workbench:read', 'board:read', 'board:manage', 'prs:read', 'prs:act'],
    impact: 'external',
    arguments: [argument('taskId', 'string', true, 'Board task id')],
  },
  {
    id: 'board.retry',
    title: 'Retry Board task',
    description: 'Move a failed task back to the ready queue for another bounded attempt.',
    access: ['workbench:read', 'board:read', 'board:manage'],
    impact: 'local',
    arguments: [argument('taskId', 'string', true, 'Board task id')],
  },
  {
    id: 'spec.create',
    title: 'Create specification',
    description: 'Save reviewed Markdown requirements in the workspace specification library.',
    access: ['workbench:read', 'specs:read', 'specs:manage'],
    impact: 'local',
    arguments: [
      argument('repo', 'string', true, 'Repository as owner/name'),
      argument('title', 'string', true, 'Specification title'),
      argument('content', 'string', true, 'Complete Markdown specification'),
    ],
  },
  {
    id: 'doc.create',
    title: 'Create documentation',
    description: 'Save reviewed Markdown in the searchable workspace knowledge base.',
    access: ['workbench:read', 'docs:read', 'docs:manage'],
    impact: 'local',
    arguments: [
      argument('repo', 'string', false, 'Optional repository as owner/name'),
      argument('title', 'string', true, 'Documentation title'),
      argument('content', 'string', true, 'Complete Markdown document'),
    ],
  },
];

interface ActionDescription {
  readonly subject: DecisionSubject;
  readonly targetId: string;
  readonly targetVersion: string | null;
  readonly title: string;
  readonly summary: string;
  readonly consequence: string;
  readonly impact: PreparedWorkbenchAction['impact'];
  readonly href: string;
}

interface LiveIssueTarget {
  readonly number: number;
  readonly title: string;
  readonly state: 'open' | 'closed';
  readonly updated_at: string;
  readonly comments: number;
  readonly labels: ReadonlyArray<string | { readonly name?: string }>;
  readonly assignees?: ReadonlyArray<{ readonly login: string }> | null;
  readonly pull_request?: unknown;
}

interface LivePullTarget {
  readonly number: number;
  readonly title: string;
  readonly state: 'open' | 'closed';
  readonly draft?: boolean;
  readonly merged_at: string | null;
  readonly updated_at: string;
  readonly head: { readonly sha?: string | null };
  readonly base: { readonly ref: string };
  readonly requested_reviewers?: ReadonlyArray<{ readonly login: string }> | null;
}

/**
 * The review-then-apply boundary shared by the SPA, AI Help, and MCP.
 * Preparation is advisory; only an ordinary human session may call execute.
 */
export class WorkbenchActions {
  constructor(
    private readonly store: WorkbenchActionsStore,
    private readonly workspace: WorkspaceService,
    private readonly operate: OperateService,
    private readonly code: CodeService,
    private readonly board: () => BoardService | undefined,
    private readonly plan: () => PlanService | undefined,
    private readonly changed: (username: string, action?: PreparedWorkbenchAction) => void,
    private readonly audit: (event: {
      readonly at: number;
      readonly actor: string;
      readonly action: string;
      readonly access: string;
      readonly status: number;
      readonly module: string;
      readonly detail: string;
    }) => void,
  ) {}

  catalog(): readonly WorkbenchActionDefinition[] {
    return WORKBENCH_ACTIONS;
  }

  list(
    user: AuthUser,
    opts: { readonly workspaceId?: string; readonly status?: PreparedWorkbenchAction['status'] } = {},
  ): PreparedWorkbenchAction[] {
    if (opts.workspaceId) this.workspace.requireAccessible(user, opts.workspaceId);
    return this.store
      .list(user.username, opts)
      .filter((action) => this.workspace.canAccessWorkspace(user, action.workspaceId));
  }

  async prepare(
    user: AuthUser,
    workspaceId: string,
    request: WorkbenchActionRequest,
    source: WorkbenchActionSource,
  ): Promise<PreparedWorkbenchAction> {
    this.workspace.requireAccessible(user, workspaceId);
    const description = await this.describe(user, workspaceId, request);
    // Delegates cannot cancel their own cards. Keep a confused agent or MCP
    // loop from filling the review surface (and the SQLite file) for 30 minutes.
    if (this.store.pendingCount(user.username) >= MAX_PENDING_ACTIONS) {
      throw badRequest(`25 actions are already waiting for review; confirm or cancel one before preparing another`);
    }
    const now = Date.now();
    const action: StoredWorkbenchAction = {
      id: `action-${randomUUID().slice(0, 12)}`,
      workspaceId,
      requestedBy: user.username,
      source,
      request,
      ...description,
      status: 'pending',
      createdAt: now,
      expiresAt: now + ACTION_TTL_MS,
      executedAt: null,
      error: null,
      result: null,
    };
    this.store.insert(action);
    this.changed(user.username, action);
    return action;
  }

  async execute(user: AuthUser, id: string, expectedAction: WorkbenchActionId): Promise<PreparedWorkbenchAction> {
    const action = this.requireOwned(user, id);
    if (action.request.action !== expectedAction) throw notFound('prepared action not found');
    if (action.status !== 'pending') throw badRequest(`action is ${action.status}, not pending`);
    if (action.expiresAt <= Date.now()) {
      if (this.store.expire() > 0) this.changed(user.username);
      throw badRequest('action expired; prepare it again against current state');
    }

    const current = await this.describe(user, action.workspaceId, action.request);
    if (current.targetId !== action.targetId || current.targetVersion !== action.targetVersion) {
      throw badRequest('the target changed after this action was prepared; review and prepare it again');
    }
    if (!this.store.claim(id, user.username)) throw badRequest('action is no longer pending');
    this.changed(user.username, this.store.get(id) ?? undefined);

    try {
      const result = await this.perform(
        user,
        action.workspaceId,
        action.request,
        action.targetId,
        action.targetVersion,
      );
      this.store.complete(id, result);
      this.record(action, user, 200, result.message);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const message = action.impact === 'local'
        ? raw
        : `${raw}. The operation may have partially applied; inspect the target before preparing another action.`;
      this.store.fail(id, message);
      this.record(action, user, 500, message);
    }
    const completed = this.store.get(id)!;
    this.changed(user.username, completed);
    return completed;
  }

  cancel(user: AuthUser, id: string): PreparedWorkbenchAction {
    const action = this.requireOwned(user, id);
    if (action.status !== 'pending') throw badRequest(`action is ${action.status}, not pending`);
    if (action.expiresAt <= Date.now()) {
      if (this.store.expire() > 0) this.changed(user.username);
      throw badRequest('action expired');
    }
    if (!this.store.cancel(id, user.username)) throw badRequest(`action is ${action.status}, not pending`);
    const cancelled = this.store.get(id)!;
    this.changed(user.username, cancelled);
    return cancelled;
  }

  recover(): number {
    return this.store.failInterrupted();
  }

  private requireOwned(user: AuthUser, id: string): StoredWorkbenchAction {
    const action = this.store.get(id);
    if (!action || action.requestedBy !== user.username) throw notFound('prepared action not found');
    this.workspace.requireAccessible(user, action.workspaceId);
    return action;
  }

  private async describe(
    user: AuthUser,
    workspaceId: string,
    request: WorkbenchActionRequest,
  ): Promise<ActionDescription> {
    switch (request.action) {
      case 'run.approve':
      case 'run.discard': {
        const run = this.operate.requireRunAccess(user, request.runId);
        if (!run.repo || !this.code.repos.inWorkspace(run.repo, workspaceId)) throw notFound('run not found in workspace');
        await this.requireRepo(user, workspaceId, run.repo);
        if (run.status !== 'review') throw badRequest(`run is ${run.status}, not waiting for review`);
        const approve = request.action === 'run.approve';
        return {
          subject: { type: 'run', id: run.id, repo: run.repo },
          targetId: run.id,
          targetVersion: `${run.status}:${run.updatedAt}`,
          title: `${approve ? 'Publish' : 'Discard'}: ${run.title}`,
          summary: approve
            ? `Commit and push the reviewed change from ${run.repo}.`
            : `Abandon the reviewed change from ${run.repo}.`,
          consequence: approve
            ? 'This writes to the remote repository and may open a pull request.'
            : 'The isolated worktree and its unpushed changes will be removed.',
          impact: approve ? 'external' : 'destructive',
          href: `#/runs/${encodeURIComponent(run.id)}/preview`,
        };
      }
      case 'pr-review.apply':
      case 'pr-review.dismiss': {
        await this.requireRepo(user, workspaceId, request.repo);
        const pr = this.code.prs.get(request.repo, request.number);
        if (!pr || pr.state !== 'open') throw notFound('open pull request not found');
        const review = this.code.prReviews.latestWithFindings(request.repo, request.number);
        if (!review || review.status !== 'pending') throw badRequest('no pending AI review for this pull request');
        const apply = request.action === 'pr-review.apply';
        const verdict = review.verdict;
        return {
          subject: { type: 'pull-request', repo: request.repo, number: request.number },
          targetId: review.id,
          targetVersion: fingerprint(JSON.stringify({
            reviewHead: review.headSha,
            pullHead: pr.headSha,
            createdAt: review.createdAt,
            verdict: review.verdict,
            findings: review.findings,
          })),
          title: `${apply ? 'Publish' : 'Dismiss'} review: ${pr.title}`,
          summary: verdict
            ? `${verdict.recommendation.replace('_', ' ')} · ${verdict.risk} risk · ${review.findings.length} finding${review.findings.length === 1 ? '' : 's'}`
            : `Manual review draft · ${review.findings.length} finding${review.findings.length === 1 ? '' : 's'}`,
          consequence: apply
            ? `This posts the ${request.mode ?? 'full'} review to GitHub as ${user.username}.`
            : 'This keeps GitHub unchanged and marks the local review dismissed.',
          impact: apply ? 'external' : 'local',
          href: `#/repos/${request.repo}/prs/${request.number}/review`,
        };
      }
      case 'pr.comment': {
        const pr = await this.liveIssueTarget(user, workspaceId, request.repo, request.number, true);
        return {
          subject: { type: 'pull-request', repo: request.repo, number: request.number },
          targetId: `${request.repo}#${request.number}`,
          // A new conversation message after preparation can change the right
          // reply. Force the agent/person to review against that newer thread.
          targetVersion: fingerprint(`${pr.state}:${pr.updated_at}:${pr.comments}`),
          title: `Comment on PR #${pr.number}: ${pr.title}`,
          summary: `${request.body.length.toLocaleString()} characters of reviewed Markdown.`,
          consequence: `This posts the comment to GitHub as ${user.username}.`,
          impact: 'external',
          href: `#/repos/${request.repo}/prs/${request.number}`,
        };
      }
      case 'pr.review-comment.reply':
      case 'pr.review-thread.resolve': {
        const pr = await this.livePullTarget(user, workspaceId, request.repo, request.number);
        const head = pr.head.sha;
        if (!head) throw badRequest('pull request has no current head commit');
        const { client } = await this.code.githubAccounts.verifiedClientFor('fetch', request.repo, {
          username: user.username,
          workspaceId,
        });
        if (!client) throw notFound('repository not found in workspace');
        const { threads } = await client.prReviewThreads(request.repo, request.number);
        const replying = request.action === 'pr.review-comment.reply';
        const thread = replying
          ? threads.find((candidate) => candidate.comments.nodes.some((comment) => comment?.databaseId === request.commentId))
          : threads.find((candidate) => candidate.id === request.threadId);
        if (!thread) throw notFound(replying ? 'review comment not found' : 'review thread not found');
        if (thread.isResolved) throw badRequest('review thread is already resolved');
        const comment = replying
          ? thread.comments.nodes.find((candidate) => candidate?.databaseId === request.commentId) ?? null
          : thread.comments.nodes.find((candidate) => candidate !== null) ?? null;
        const location = `${thread.path}:${thread.line ?? comment?.line ?? comment?.originalLine ?? '?'}`;
        return {
          subject: { type: 'pull-request', repo: request.repo, number: request.number },
          targetId: replying ? `${request.repo}#${request.number}:comment:${request.commentId}` : thread.id,
          targetVersion: `${head}:${fingerprint(JSON.stringify({
            threadId: thread.id,
            resolved: thread.isResolved,
            outdated: thread.isOutdated,
            comments: thread.comments.nodes.map((entry) => entry && [entry.databaseId, entry.body, entry.createdAt]),
          }))}`,
          title: replying
            ? `Reply to @${comment?.author?.login ?? 'unknown'} on PR #${pr.number}`
            : `Resolve review thread on PR #${pr.number}`,
          summary: replying
            ? `${location} · ${request.body.length.toLocaleString()} characters of reviewed Markdown.`
            : `${location} · ${thread.comments.nodes.length} comment${thread.comments.nodes.length === 1 ? '' : 's'}.`,
          consequence: replying
            ? `This replies inside the existing GitHub review thread as ${user.username}.`
            : 'This marks the whole GitHub review thread as resolved.',
          impact: 'external',
          href: `#/repos/${request.repo}/prs/${request.number}`,
        };
      }
      case 'pr.review-comment.create': {
        const pr = await this.livePullTarget(user, workspaceId, request.repo, request.number);
        const head = pr.head.sha;
        if (!head) throw badRequest('pull request has no current head commit');
        if (request.startLine !== undefined && request.startLine > request.line) {
          throw badRequest('review comment startLine cannot be after line');
        }
        const { client } = await this.code.githubAccounts.verifiedClientFor('fetch', request.repo, {
          username: user.username,
          workspaceId,
        });
        if (!client) throw notFound('repository not found in workspace');
        const { files } = await client.prFiles(request.repo, request.number);
        const index = buildAnchorIndex(unifiedDiffFromPatches(files));
        const problem = checkAnchor(index, {
          file: request.path,
          side: request.side,
          line: request.line,
          startLine: request.startLine ?? null,
        }, request.quotedLine);
        if (problem) throw badRequest(`review comment cannot be anchored to the current diff: ${problem}`);
        const content = reviewCommentBody(request.body, request.suggestion);
        if (content.length > 64_000) throw badRequest('review comment is too long after adding the suggestion');
        const range = request.startLine === undefined ? `${request.line}` : `${request.startLine}-${request.line}`;
        return {
          subject: { type: 'pull-request', repo: request.repo, number: request.number },
          targetId: `${request.repo}#${request.number}:${request.path}:${request.side}:${range}`,
          targetVersion: `${head}:${fingerprint(JSON.stringify({
            updatedAt: pr.updated_at,
            path: request.path,
            side: request.side,
            line: request.line,
            startLine: request.startLine ?? null,
            actualLine: index.lineText(request.path, request.side, request.line),
          }))}`,
          title: `Comment on ${request.path}:${range} in PR #${pr.number}`,
          summary: request.suggestion
            ? `${content.length.toLocaleString()} characters including an exact replacement suggestion.`
            : `${content.length.toLocaleString()} characters of reviewed Markdown.`,
          consequence: `This opens a new inline GitHub review thread at the selected diff ${request.side.toLowerCase()} line.`,
          impact: 'external',
          href: `#/repos/${request.repo}/prs/${request.number}`,
        };
      }
      case 'pr.labels.add':
      case 'pr.labels.remove': {
        const pr = await this.liveIssueTarget(user, workspaceId, request.repo, request.number, true);
        const removing = request.action === 'pr.labels.remove';
        const current = new Set(normalizedLabels(pr.labels));
        if (removing && request.labels.some((label) => !current.has(label))) {
          throw badRequest('one or more labels are no longer present on this pull request');
        }
        return {
          subject: { type: 'pull-request', repo: request.repo, number: request.number },
          targetId: `${request.repo}#${request.number}`,
          targetVersion: fingerprint(`${pr.updated_at}:${normalizedLabels(pr.labels).join('\n')}`),
          title: `${removing ? 'Remove labels from' : 'Add labels to'} PR #${pr.number}: ${pr.title}`,
          summary: request.labels.join(', '),
          consequence: removing
            ? 'This removes the listed labels from GitHub; other labels remain unchanged.'
            : 'This adds the listed labels on GitHub; existing labels remain unchanged.',
          impact: 'external',
          href: `#/repos/${request.repo}/prs/${request.number}`,
        };
      }
      case 'pr.assignees.add':
      case 'pr.assignees.remove': {
        const pr = await this.liveIssueTarget(user, workspaceId, request.repo, request.number, true);
        const removing = request.action === 'pr.assignees.remove';
        const current = pr.assignees?.map((assignee) => assignee.login).sort() ?? [];
        if (removing && request.assignees.some((assignee) => !current.includes(assignee))) {
          throw badRequest('one or more users are no longer assigned to this pull request');
        }
        return {
          subject: { type: 'pull-request', repo: request.repo, number: request.number },
          targetId: `${request.repo}#${request.number}`,
          targetVersion: fingerprint(JSON.stringify({ updatedAt: pr.updated_at, assignees: current })),
          title: `${removing ? 'Unassign' : 'Assign'} PR #${pr.number}: ${pr.title}`,
          summary: request.assignees.join(', '),
          consequence: removing
            ? 'This removes the listed GitHub users from the pull-request assignees.'
            : 'This adds the listed GitHub users as pull-request assignees.',
          impact: 'external',
          href: `#/repos/${request.repo}/prs/${request.number}`,
        };
      }
      case 'pr.review.submit': {
        const pr = await this.livePullTarget(user, workspaceId, request.repo, request.number);
        const head = pr.head.sha;
        if (!head) throw badRequest('pull request has no current head commit');
        if (pr.draft) throw badRequest('draft pull requests must be marked ready before submitting a review');
        const approving = request.verdict === 'approve';
        return {
          subject: { type: 'pull-request', repo: request.repo, number: request.number },
          targetId: `${request.repo}#${request.number}`,
          targetVersion: `${head}:${fingerprint(`${pr.updated_at}:${pr.draft}`)}`,
          title: `${approving ? 'Approve' : 'Request changes on'} PR #${pr.number}: ${pr.title}`,
          summary: `${request.body.length.toLocaleString()} characters of reviewed Markdown against ${head.slice(0, 12)}.`,
          consequence: `This submits a GitHub ${approving ? 'approval' : 'changes-requested review'} as ${user.username}. GitHub rejects reviews by the pull-request author.`,
          impact: 'external',
          href: `#/repos/${request.repo}/prs/${request.number}`,
        };
      }
      case 'pr.ready': {
        const pr = await this.livePullTarget(user, workspaceId, request.repo, request.number);
        if (!pr.draft) throw badRequest('pull request is already ready for review');
        return {
          subject: { type: 'pull-request', repo: request.repo, number: request.number },
          targetId: `${request.repo}#${request.number}`,
          targetVersion: fingerprint(`${pr.updated_at}:${pr.head.sha ?? ''}:${pr.draft}`),
          title: `Mark PR #${pr.number} ready: ${pr.title}`,
          summary: 'Move this draft pull request into review.',
          consequence: 'This marks the pull request ready for review on GitHub and may notify requested reviewers.',
          impact: 'external',
          href: `#/repos/${request.repo}/prs/${request.number}`,
        };
      }
      case 'pr.close':
      case 'pr.reopen': {
        const reopening = request.action === 'pr.reopen';
        const pr = await this.livePullTarget(user, workspaceId, request.repo, request.number, reopening ? 'closed' : 'open');
        if (reopening && pr.merged_at) throw badRequest('merged pull requests cannot be reopened');
        const verb = reopening ? 'Reopen' : 'Close';
        return {
          subject: { type: 'pull-request', repo: request.repo, number: request.number },
          targetId: `${request.repo}#${request.number}`,
          targetVersion: fingerprint(`${pr.state}:${pr.updated_at}:${pr.head.sha ?? ''}:${pr.merged_at ?? ''}`),
          title: `${verb} PR #${pr.number}: ${pr.title}`,
          summary: request.comment
            ? `${verb} the pull request with ${request.comment.length.toLocaleString()} characters of reviewed Markdown.`
            : `${verb} the pull request without posting a comment.`,
          consequence: request.comment
            ? `This ${reopening ? 'reopens' : 'closes'} the pull request on GitHub and posts the comment as ${user.username}.`
            : `This ${reopening ? 'reopens' : 'closes'} the pull request on GitHub.`,
          impact: 'external',
          href: `#/repos/${request.repo}/prs/${request.number}`,
        };
      }
      case 'pr.reviewers.request':
      case 'pr.reviewers.remove':
      case 'pr.checks.rerun':
      case 'pr.update-branch':
      case 'pr.merge': {
        const pr = await this.livePullTarget(user, workspaceId, request.repo, request.number);
        const head = pr.head.sha;
        if (!head) throw badRequest('pull request has no current head commit');
        const requestingReview = request.action === 'pr.reviewers.request';
        const removingReview = request.action === 'pr.reviewers.remove';
        const rerunning = request.action === 'pr.checks.rerun';
        const merging = request.action === 'pr.merge';
        const requested = pr.requested_reviewers?.map((reviewer) => reviewer.login).sort() ?? [];
        if (removingReview && request.reviewers.some((reviewer) => !requested.includes(reviewer))) {
          throw badRequest('one or more users no longer have an outstanding review request');
        }
        return {
          subject: { type: 'pull-request', repo: request.repo, number: request.number },
          targetId: `${request.repo}#${request.number}`,
          targetVersion: `${head}:${fingerprint(`${pr.updated_at}:${pr.base.ref}:${requested.join(',')}`)}`,
          title: requestingReview
            ? `Request review on PR #${pr.number}: ${pr.title}`
            : removingReview
              ? `Remove review request on PR #${pr.number}: ${pr.title}`
            : rerunning
              ? `Re-run checks on PR #${pr.number}: ${pr.title}`
              : merging
                ? `${request.method === 'squash' ? 'Squash merge' : request.method === 'rebase' ? 'Rebase and merge' : 'Merge'} PR #${pr.number}: ${pr.title}`
              : `Update branch for PR #${pr.number}: ${pr.title}`,
          summary: requestingReview || removingReview
            ? request.reviewers.join(', ')
            : rerunning
              ? `${request.scope === 'all' ? 'All workflow runs' : 'Failed workflow jobs'} at ${head.slice(0, 12)}`
              : merging
                ? `${request.method} the exact reviewed head ${head.slice(0, 12)} into ${pr.base.ref}.`
              : `Merge ${pr.base.ref} into the current head ${head.slice(0, 12)}.`,
          consequence: requestingReview
            ? 'This sends GitHub review requests to the listed users.'
            : removingReview
              ? 'This removes the listed outstanding GitHub review requests.'
            : rerunning
              ? 'This consumes CI capacity by restarting GitHub Actions workflow runs.'
              : merging
                ? 'This merges code on GitHub and may delete the merged source branch. GitHub branch protections and rulesets still apply.'
              : 'This changes the pull-request branch and starts any checks configured for the new head.',
          impact: 'external',
          href: `#/repos/${request.repo}/prs/${request.number}`,
        };
      }
      case 'issue-triage.apply':
      case 'issue-triage.dismiss': {
        await this.requireRepo(user, workspaceId, request.repo);
        const issue = this.code.issues.get(request.repo, request.number);
        if (!issue || issue.state !== 'open') throw notFound('open issue not found');
        const triage = this.code.triage.latest(request.repo, request.number);
        if (!triage || triage.status !== 'pending' || !triage.verdict) {
          throw badRequest('no pending triage result for this issue');
        }
        const apply = request.action === 'issue-triage.apply';
        return {
          subject: { type: 'issue', repo: request.repo, number: request.number },
          targetId: triage.id,
          targetVersion: fingerprint(JSON.stringify({ createdAt: triage.createdAt, verdict: triage.verdict })),
          title: `${apply ? 'Apply' : 'Dismiss'} triage: ${issue.title}`,
          summary: `${triage.verdict.kind} · ${triage.verdict.severity} · ${triage.verdict.labels.join(', ') || 'no labels'}`,
          consequence: apply
            ? `This applies labels${request.comment ? ' and posts the proposed reply' : ''} on GitHub as ${user.username}.`
            : 'This keeps GitHub unchanged and marks the local verdict dismissed.',
          impact: apply ? 'external' : 'local',
          href: `#/repos/${request.repo}/issues/${request.number}`,
        };
      }
      case 'issue.comment': {
        const issue = await this.liveIssueTarget(user, workspaceId, request.repo, request.number, false);
        return {
          subject: { type: 'issue', repo: request.repo, number: request.number },
          targetId: `${request.repo}#${request.number}`,
          targetVersion: fingerprint(`${issue.state}:${issue.updated_at}:${issue.comments}`),
          title: `Comment on issue #${issue.number}: ${issue.title}`,
          summary: `${request.body.length.toLocaleString()} characters of reviewed Markdown.`,
          consequence: `This posts the comment to GitHub as ${user.username}.`,
          impact: 'external',
          href: `#/repos/${request.repo}/issues/${request.number}`,
        };
      }
      case 'issue.close':
      case 'issue.reopen': {
        const reopening = request.action === 'issue.reopen';
        const issue = await this.liveIssueTarget(user, workspaceId, request.repo, request.number, false, reopening ? 'closed' : 'open');
        const verb = reopening ? 'Reopen' : 'Close';
        return {
          subject: { type: 'issue', repo: request.repo, number: request.number },
          targetId: `${request.repo}#${request.number}`,
          targetVersion: fingerprint(`${issue.state}:${issue.updated_at}:${issue.comments}`),
          title: `${verb} issue #${issue.number}: ${issue.title}`,
          summary: request.comment
            ? `${verb} the issue with ${request.comment.length.toLocaleString()} characters of reviewed Markdown.`
            : `${verb} the issue without posting a comment.`,
          consequence: request.comment
            ? `This ${reopening ? 'reopens' : 'closes'} the issue on GitHub and posts the comment as ${user.username}.`
            : `This ${reopening ? 'reopens' : 'closes'} the issue on GitHub.`,
          impact: 'external',
          href: `#/repos/${request.repo}/issues/${request.number}`,
        };
      }
      case 'issue.labels.add':
      case 'issue.labels.remove':
      case 'issue.assignees.add':
      case 'issue.assignees.remove': {
        const issue = await this.liveIssueTarget(user, workspaceId, request.repo, request.number, false);
        const labels = request.action === 'issue.labels.add' || request.action === 'issue.labels.remove';
        const removing = request.action === 'issue.labels.remove' || request.action === 'issue.assignees.remove';
        const values = labels ? request.labels : request.assignees;
        const current = labels
          ? normalizedLabels(issue.labels)
          : (issue.assignees?.map((assignee) => assignee.login) ?? []);
        if (removing && values.some((value) => !current.includes(value))) {
          throw badRequest(`one or more ${labels ? 'labels are' : 'users are'} no longer present on this issue`);
        }
        return {
          subject: { type: 'issue', repo: request.repo, number: request.number },
          targetId: `${request.repo}#${request.number}`,
          targetVersion: fingerprint(JSON.stringify({
            updatedAt: issue.updated_at,
            labels: normalizedLabels(issue.labels),
            assignees: issue.assignees?.map((item) => item.login).sort() ?? [],
          })),
          title: `${labels
            ? (removing ? 'Remove labels from' : 'Add labels to')
            : (removing ? 'Unassign' : 'Assign')} issue #${issue.number}: ${issue.title}`,
          summary: values.join(', '),
          consequence: labels
            ? (removing
                ? 'This removes the listed labels from GitHub; other labels remain unchanged.'
                : 'This adds the listed labels on GitHub; existing labels remain unchanged.')
            : (removing
                ? 'This removes the listed GitHub users from the issue assignees.'
                : 'This adds the listed GitHub users as issue assignees.'),
          impact: 'external',
          href: `#/repos/${request.repo}/issues/${request.number}`,
        };
      }
      case 'board.merge':
      case 'board.retry': {
        const board = this.board();
        if (!board) throw badRequest('Board is not enabled');
        const detail = board.getTask(user, request.taskId);
        if (!detail || detail.task.workspaceId !== workspaceId) throw notFound('Board task not found');
        await this.requireRepo(user, workspaceId, detail.task.repo);
        const merge = request.action === 'board.merge';
        let mergeHead: string | null = null;
        if (merge) {
          if (detail.task.status !== 'in_review' || detail.task.prNumber === null) {
            throw badRequest('task is not waiting at a pull-request merge gate');
          }
          const pr = this.code.prs.get(detail.task.repo, detail.task.prNumber);
          if (!pr || pr.state !== 'open' || !pr.headSha) {
            throw badRequest('the task pull request has no current head; sync it before preparing a merge');
          }
          mergeHead = pr.headSha;
        } else if (detail.task.status !== 'failed') {
          throw badRequest(`task is ${detail.task.status}, not failed`);
        }
        return {
          subject: { type: 'task', id: detail.task.id, repo: detail.task.repo },
          targetId: detail.task.id,
          targetVersion: merge
            ? `${mergeHead!}:${fingerprint(`${detail.task.status}:${detail.task.stage ?? ''}:${detail.task.updatedAt}`)}`
            : `${detail.task.status}:${detail.task.stage ?? ''}:${detail.task.updatedAt}`,
          title: `${merge ? 'Merge' : 'Retry'}: ${detail.task.title}`,
          summary: merge
            ? `Merge pull request #${detail.task.prNumber} and complete the Board task.`
            : `Reset the failure and return the task to the ready queue.`,
          consequence: merge
            ? 'This merges code on GitHub and marks the task complete.'
            : 'A worker may start another implementation attempt immediately.',
          impact: merge ? 'external' : 'local',
          href: `#/board?task=${encodeURIComponent(detail.task.id)}`,
        };
      }
      case 'spec.create': {
        if (!this.plan()) throw badRequest('Specifications are not enabled');
        this.requireLocalRepo(user, workspaceId, request.repo);
        return {
          subject: { type: 'content', area: 'specification', repo: request.repo },
          targetId: `new-spec:${request.repo}`,
          targetVersion: fingerprint(`${request.title}\n${request.content}`),
          title: `Create specification: ${request.title}`,
          summary: `${request.content.length.toLocaleString()} characters of reviewed Markdown for ${request.repo}.`,
          consequence: 'This adds a virtual specification; it does not start implementation or write to GitHub.',
          impact: 'local',
          href: '#/specs',
        };
      }
      case 'doc.create': {
        if (!this.plan()) throw badRequest('Documentation is not enabled');
        if (request.repo) this.requireLocalRepo(user, workspaceId, request.repo);
        return {
          subject: { type: 'content', area: 'documentation', repo: request.repo ?? null },
          targetId: `new-doc:${request.repo ?? workspaceId}`,
          targetVersion: fingerprint(`${request.title}\n${request.content}`),
          title: `Create documentation: ${request.title}`,
          summary: `${request.content.length.toLocaleString()} characters of searchable workspace knowledge.`,
          consequence: 'This adds a virtual documentation entry; it does not modify a repository.',
          impact: 'local',
          href: '#/docs',
        };
      }
    }
  }

  private async perform(
    user: AuthUser,
    workspaceId: string,
    request: WorkbenchActionRequest,
    targetId: string,
    targetVersion: string | null,
  ): Promise<WorkbenchActionResult> {
    switch (request.action) {
      case 'run.approve': {
        const result = await this.code.fixes.approve(
          targetId,
          { ...(request.title ? { title: request.title } : {}), ...(request.body ? { body: request.body } : {}) },
          user.username,
        );
        return { message: `Agent change published: ${result.prUrl}`, href: `#/runs/${encodeURIComponent(targetId)}` };
      }
      case 'run.discard':
        await this.code.fixes.discard(targetId);
        return { message: 'Agent change discarded.', href: '#/runs' };
      case 'pr-review.apply': {
        const result = await this.code.prReviews.apply(targetId, {
          userId: user.username,
          ...(request.mode ? { mode: request.mode } : {}),
        });
        await this.code.sync.syncPr(result.repo, result.number, user.username);
        return {
          message: `Review published to ${result.repo}#${result.number}.`,
          href: `#/repos/${result.repo}/prs/${result.number}/review`,
        };
      }
      case 'pr-review.dismiss':
        this.code.prReviews.dismiss(targetId);
        return {
          message: `Review dismissed for ${request.repo}#${request.number}.`,
          href: `#/repos/${request.repo}/prs/${request.number}/review`,
        };
      case 'pr.comment': {
        const { result } = await this.code.githubAccounts.performForRepo(
          'pipelines',
          request.repo,
          (client) => client.comment(request.repo, request.number, request.body),
          { username: user.username, workspaceId, need: 'push' },
        );
        if (!result) throw new Error(`your connected GitHub accounts cannot comment on ${request.repo}`);
        await this.code.sync.syncPr(request.repo, request.number, user.username, workspaceId);
        return {
          message: `Comment posted to ${request.repo}#${request.number}.`,
          href: `#/repos/${request.repo}/prs/${request.number}`,
        };
      }
      case 'pr.review-comment.reply': {
        await this.performRepoWrite(user, workspaceId, request.repo, (client) =>
          client.replyToReviewComment(request.repo, request.number, request.commentId, request.body).then(() => undefined),
        );
        await this.code.sync.syncPr(request.repo, request.number, user.username, workspaceId);
        return {
          message: `Reply posted in the review thread on ${request.repo}#${request.number}.`,
          href: `#/repos/${request.repo}/prs/${request.number}`,
        };
      }
      case 'pr.review-comment.create': {
        const head = reviewedHead(targetVersion);
        const body = reviewCommentBody(request.body, request.suggestion);
        await this.performRepoWrite(user, workspaceId, request.repo, (client) =>
          client.createReviewComment(request.repo, request.number, {
            commit_id: head,
            path: request.path,
            body,
            line: request.line,
            side: request.side,
            ...(request.startLine === undefined
              ? {}
              : { start_line: request.startLine, start_side: request.side }),
          }).then(() => undefined),
        );
        await this.code.sync.syncPr(request.repo, request.number, user.username, workspaceId);
        return {
          message: `Inline review comment posted on ${request.path}:${request.line}.`,
          href: `#/repos/${request.repo}/prs/${request.number}`,
        };
      }
      case 'pr.review-thread.resolve': {
        await this.performRepoWrite(user, workspaceId, request.repo, (client) =>
          client.resolveReviewThread(request.threadId),
        );
        await this.code.sync.syncPr(request.repo, request.number, user.username, workspaceId);
        return {
          message: `Review thread resolved on ${request.repo}#${request.number}.`,
          href: `#/repos/${request.repo}/prs/${request.number}`,
        };
      }
      case 'pr.labels.add': {
        await this.performRepoWrite(user, workspaceId, request.repo, (client) =>
          client.addLabels(request.repo, request.number, [...request.labels]),
        );
        await this.code.sync.syncPr(request.repo, request.number, user.username, workspaceId);
        return {
          message: `Labels added to ${request.repo}#${request.number}.`,
          href: `#/repos/${request.repo}/prs/${request.number}`,
        };
      }
      case 'pr.labels.remove': {
        await this.performRepoWrite(user, workspaceId, request.repo, async (client) => {
          for (const label of request.labels) await client.removeLabel(request.repo, request.number, label);
        });
        await this.code.sync.syncPr(request.repo, request.number, user.username, workspaceId);
        return {
          message: `Labels removed from ${request.repo}#${request.number}.`,
          href: `#/repos/${request.repo}/prs/${request.number}`,
        };
      }
      case 'pr.reviewers.request': {
        await this.performRepoWrite(user, workspaceId, request.repo, (client) =>
          client.requestReviewers(request.repo, request.number, [...request.reviewers]),
        );
        await this.code.sync.syncPr(request.repo, request.number, user.username, workspaceId);
        return {
          message: `Review requested from ${request.reviewers.join(', ')}.`,
          href: `#/repos/${request.repo}/prs/${request.number}`,
        };
      }
      case 'pr.reviewers.remove': {
        await this.performRepoWrite(user, workspaceId, request.repo, (client) =>
          client.removeReviewers(request.repo, request.number, [...request.reviewers]),
        );
        await this.code.sync.syncPr(request.repo, request.number, user.username, workspaceId);
        return {
          message: `Review requests removed for ${request.reviewers.join(', ')}.`,
          href: `#/repos/${request.repo}/prs/${request.number}`,
        };
      }
      case 'pr.assignees.add': {
        await this.performRepoWrite(user, workspaceId, request.repo, (client) =>
          client.addAssignees(request.repo, request.number, [...request.assignees]),
        );
        await this.code.sync.syncPr(request.repo, request.number, user.username, workspaceId);
        return {
          message: `Assigned ${request.assignees.join(', ')} to ${request.repo}#${request.number}.`,
          href: `#/repos/${request.repo}/prs/${request.number}`,
        };
      }
      case 'pr.assignees.remove': {
        await this.performRepoWrite(user, workspaceId, request.repo, (client) =>
          client.removeAssignees(request.repo, request.number, [...request.assignees]),
        );
        await this.code.sync.syncPr(request.repo, request.number, user.username, workspaceId);
        return {
          message: `Unassigned ${request.assignees.join(', ')} from ${request.repo}#${request.number}.`,
          href: `#/repos/${request.repo}/prs/${request.number}`,
        };
      }
      case 'pr.review.submit': {
        const head = reviewedHead(targetVersion);
        await this.performRepoWrite(user, workspaceId, request.repo, async (client) => {
          const live = await client.pull(request.repo, request.number);
          if (live.state !== 'open' || live.draft || live.head.sha !== head) {
            throw new Error('the pull request changed before the review could be submitted; prepare it again');
          }
          await client.createPrReview(request.repo, request.number, {
            body: request.body,
            event: request.verdict === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES',
            commitId: head,
          });
        });
        await this.code.sync.syncPr(request.repo, request.number, user.username, workspaceId);
        return {
          message: `${request.verdict === 'approve' ? 'Approval' : 'Changes-requested review'} submitted to ${request.repo}#${request.number}.`,
          href: `#/repos/${request.repo}/prs/${request.number}`,
        };
      }
      case 'pr.checks.rerun': {
        const head = reviewedHead(targetVersion);
        let restarted = 0;
        await this.performRepoWrite(user, workspaceId, request.repo, async (client) => {
          restarted = await client.rerunChecks(request.repo, head, request.scope);
        });
        return {
          message: restarted === 1 ? 'One workflow run restarted.' : `${restarted} workflow runs restarted.`,
          href: `#/repos/${request.repo}/prs/${request.number}`,
        };
      }
      case 'pr.update-branch': {
        await this.performRepoWrite(user, workspaceId, request.repo, (client) =>
          client.updateBranch(request.repo, request.number),
        );
        await this.code.sync.syncPr(request.repo, request.number, user.username, workspaceId);
        return {
          message: `Branch update requested for ${request.repo}#${request.number}.`,
          href: `#/repos/${request.repo}/prs/${request.number}`,
        };
      }
      case 'pr.ready': {
        await this.performRepoWrite(user, workspaceId, request.repo, async (client) => {
          const live = await client.pull(request.repo, request.number);
          if (live.state !== 'open' || live.draft !== true) {
            throw new Error('the pull request is no longer an open draft; prepare the action again');
          }
          await client.markReadyForReview(request.repo, request.number);
        });
        await this.code.sync.syncPr(request.repo, request.number, user.username, workspaceId);
        return {
          message: `${request.repo}#${request.number} marked ready for review.`,
          href: `#/repos/${request.repo}/prs/${request.number}`,
        };
      }
      case 'pr.close':
      case 'pr.reopen': {
        const reopening = request.action === 'pr.reopen';
        await this.performRepoWrite(user, workspaceId, request.repo, async (client) => {
          const live = await client.pull(request.repo, request.number);
          const expectedState = reopening ? 'closed' : 'open';
          if (live.state !== expectedState || live.merged_at) {
            throw new Error(`the pull request is no longer ${expectedState} and unmerged; prepare the action again`);
          }
          if (reopening) await client.reopenPr(request.repo, request.number);
          if (request.comment) await client.comment(request.repo, request.number, request.comment);
          if (!reopening) await client.closePr(request.repo, request.number);
        });
        await this.code.sync.syncPr(request.repo, request.number, user.username, workspaceId);
        return {
          message: `Pull request ${request.repo}#${request.number} ${reopening ? 'reopened' : 'closed'}${request.comment ? ' with a comment' : ''}.`,
          href: `#/repos/${request.repo}/prs/${request.number}`,
        };
      }
      case 'pr.merge': {
        await this.code.prReviews.merge(request.repo, request.number, request.method, user.username);
        await this.code.sync.syncPr(request.repo, request.number, user.username, workspaceId);
        return {
          message: `${request.repo}#${request.number} merged with ${request.method}.`,
          href: `#/repos/${request.repo}/prs/${request.number}`,
        };
      }
      case 'issue-triage.apply': {
        const result = await this.code.triage.apply(targetId, {
          comment: request.comment ?? false,
          userId: user.username,
        });
        await this.code.sync.syncIssue(result.repo, result.number, user.username);
        return {
          message: `Triage applied to ${result.repo}#${result.number}.`,
          href: `#/repos/${result.repo}/issues/${result.number}`,
        };
      }
      case 'issue-triage.dismiss':
        this.code.triage.dismiss(targetId);
        return {
          message: `Triage dismissed for ${request.repo}#${request.number}.`,
          href: `#/repos/${request.repo}/issues/${request.number}`,
        };
      case 'issue.comment': {
        const { result } = await this.code.githubAccounts.performForRepo(
          'pipelines',
          request.repo,
          (client) => client.comment(request.repo, request.number, request.body),
          { username: user.username, workspaceId, need: 'push' },
        );
        if (!result) throw new Error(`your connected GitHub accounts cannot comment on ${request.repo}`);
        await this.code.sync.syncIssue(request.repo, request.number, user.username, workspaceId);
        return {
          message: `Comment posted to ${request.repo}#${request.number}.`,
          href: `#/repos/${request.repo}/issues/${request.number}`,
        };
      }
      case 'issue.close': {
        const { result } = await this.code.githubAccounts.performForRepo(
          'pipelines',
          request.repo,
          async (client) => {
            const live = await client.issue(request.repo, request.number);
            if (live.state !== 'open' || live.pull_request) {
              throw new Error('the issue is no longer open; prepare the action again');
            }
            if (request.comment) await client.comment(request.repo, request.number, request.comment);
            await client.updateIssueState(request.repo, request.number, 'closed');
            return true;
          },
          { username: user.username, workspaceId, need: 'push' },
        );
        if (!result) throw new Error(`your connected GitHub accounts cannot close issues in ${request.repo}`);
        await this.code.sync.syncIssue(request.repo, request.number, user.username, workspaceId);
        return {
          message: `Issue ${request.repo}#${request.number} closed${request.comment ? ' with a comment' : ''}.`,
          href: `#/repos/${request.repo}/issues/${request.number}`,
        };
      }
      case 'issue.reopen': {
        const { result } = await this.code.githubAccounts.performForRepo(
          'pipelines',
          request.repo,
          async (client) => {
            const live = await client.issue(request.repo, request.number);
            if (live.state !== 'closed' || live.pull_request) {
              throw new Error('the issue is no longer closed; prepare the action again');
            }
            await client.updateIssueState(request.repo, request.number, 'open');
            if (request.comment) await client.comment(request.repo, request.number, request.comment);
            return true;
          },
          { username: user.username, workspaceId, need: 'push' },
        );
        if (!result) throw new Error(`your connected GitHub accounts cannot reopen issues in ${request.repo}`);
        await this.code.sync.syncIssue(request.repo, request.number, user.username, workspaceId);
        return {
          message: `Issue ${request.repo}#${request.number} reopened${request.comment ? ' with a comment' : ''}.`,
          href: `#/repos/${request.repo}/issues/${request.number}`,
        };
      }
      case 'issue.labels.add': {
        await this.performRepoWrite(user, workspaceId, request.repo, (client) =>
          client.addLabels(request.repo, request.number, [...request.labels]),
        );
        await this.code.sync.syncIssue(request.repo, request.number, user.username, workspaceId);
        return {
          message: `Labels added to ${request.repo}#${request.number}.`,
          href: `#/repos/${request.repo}/issues/${request.number}`,
        };
      }
      case 'issue.labels.remove': {
        await this.performRepoWrite(user, workspaceId, request.repo, async (client) => {
          for (const label of request.labels) await client.removeLabel(request.repo, request.number, label);
        });
        await this.code.sync.syncIssue(request.repo, request.number, user.username, workspaceId);
        return {
          message: `Labels removed from ${request.repo}#${request.number}.`,
          href: `#/repos/${request.repo}/issues/${request.number}`,
        };
      }
      case 'issue.assignees.add': {
        await this.performRepoWrite(user, workspaceId, request.repo, (client) =>
          client.addAssignees(request.repo, request.number, [...request.assignees]),
        );
        await this.code.sync.syncIssue(request.repo, request.number, user.username, workspaceId);
        return {
          message: `Assigned ${request.assignees.join(', ')} to ${request.repo}#${request.number}.`,
          href: `#/repos/${request.repo}/issues/${request.number}`,
        };
      }
      case 'issue.assignees.remove': {
        await this.performRepoWrite(user, workspaceId, request.repo, (client) =>
          client.removeAssignees(request.repo, request.number, [...request.assignees]),
        );
        await this.code.sync.syncIssue(request.repo, request.number, user.username, workspaceId);
        return {
          message: `Unassigned ${request.assignees.join(', ')} from ${request.repo}#${request.number}.`,
          href: `#/repos/${request.repo}/issues/${request.number}`,
        };
      }
      case 'board.merge': {
        const board = this.board();
        if (!board) throw new Error('Board was disabled before execution');
        await board.mergeNow(targetId, user.username, boardMergeHead(targetVersion));
        return { message: 'Board task merged and completed.', href: `#/board?task=${encodeURIComponent(targetId)}` };
      }
      case 'board.retry': {
        const board = this.board();
        if (!board) throw new Error('Board was disabled before execution');
        await board.moveTask(targetId, 'ready');
        return { message: 'Board task returned to the ready queue.', href: `#/board?task=${encodeURIComponent(targetId)}` };
      }
      case 'spec.create': {
        const plan = this.plan();
        if (!plan) throw new Error('Specifications were disabled before execution');
        const spec = plan.specs.create(workspaceId, request.repo, request.title, request.content, 'virtual');
        return { message: `Specification created: ${spec.title}.`, href: '#/specs' };
      }
      case 'doc.create': {
        const plan = this.plan();
        if (!plan) throw new Error('Documentation was disabled before execution');
        const doc = plan.docs.create(
          workspaceId,
          { repo: request.repo ?? null, title: request.title, content: request.content, storage: 'virtual' },
          'manual',
        );
        return { message: `Documentation created: ${doc.title}.`, href: '#/docs' };
      }
    }
  }

  private async requireRepo(user: AuthUser, workspaceId: string, repo: string): Promise<void> {
    if (!this.code.repos.inWorkspace(repo, workspaceId) || !this.workspace.canAccessRepo(user, repo)) {
      throw notFound('repository not found in workspace');
    }
    const permission = await this.code.githubAccounts.permissionFor('fetch', repo, {
      username: user.username,
      workspaceId,
    });
    if (!permission) throw notFound('repository not found in workspace');
  }

  private async liveIssueTarget(
    user: AuthUser,
    workspaceId: string,
    repo: string,
    number: number,
    pullRequest: boolean,
    state: 'open' | 'closed' = 'open',
  ): Promise<LiveIssueTarget> {
    await this.requireRepo(user, workspaceId, repo);
    const { client } = await this.code.githubAccounts.verifiedClientFor('fetch', repo, {
      username: user.username,
      workspaceId,
    });
    if (!client) throw notFound('repository not found in workspace');
    const target = await client.issue(repo, number);
    if (target.state !== state || Boolean(target.pull_request) !== pullRequest) {
      throw notFound(`${state} ${pullRequest ? 'pull request' : 'issue'} not found`);
    }
    return target;
  }

  private async livePullTarget(
    user: AuthUser,
    workspaceId: string,
    repo: string,
    number: number,
    state: 'open' | 'closed' = 'open',
  ): Promise<LivePullTarget> {
    await this.requireRepo(user, workspaceId, repo);
    const { client } = await this.code.githubAccounts.verifiedClientFor('fetch', repo, {
      username: user.username,
      workspaceId,
    });
    if (!client) throw notFound('repository not found in workspace');
    const target = await client.pull(repo, number);
    if (target.state !== state) throw notFound(`${state} pull request not found`);
    return target;
  }

  private async performRepoWrite(
    user: AuthUser,
    workspaceId: string,
    repo: string,
    action: (client: Parameters<Parameters<CodeService['githubAccounts']['performForRepo']>[2]>[0]) => Promise<void>,
  ): Promise<void> {
    const { result } = await this.code.githubAccounts.performForRepo(
      'pipelines',
      repo,
      async (client) => {
        await action(client);
        return true;
      },
      { username: user.username, workspaceId, need: 'push' },
    );
    if (!result) throw new Error(`your connected GitHub accounts cannot write to ${repo}`);
  }

  /** Plan's virtual content only needs the same connected-repo membership gate as its own routes. */
  private requireLocalRepo(user: AuthUser, workspaceId: string, repo: string): void {
    if (!this.code.repos.inWorkspace(repo, workspaceId) || !this.workspace.canAccessRepo(user, repo)) {
      throw notFound('repository not found in workspace');
    }
  }

  private record(
    action: StoredWorkbenchAction,
    user: AuthUser,
    status: number,
    detail: string,
  ): void {
    const definition = WORKBENCH_ACTIONS.find((item) => item.id === action.request.action)!;
    this.audit({
      at: Date.now(),
      actor: user.username,
      action: `workbench.${action.request.action}`,
      access: definition.access.join(' & '),
      status,
      module: 'workbench',
      detail: `${action.id}: ${detail}`.slice(0, 1000),
    });
  }
}

function argument(
  name: string,
  type: 'string' | 'string[]' | 'integer' | 'boolean',
  required: boolean,
  description: string,
  options?: readonly string[],
): WorkbenchActionDefinition['arguments'][number] {
  return { name, type, required, description, ...(options ? { options } : {}) };
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function normalizedLabels(labels: LiveIssueTarget['labels']): string[] {
  return labels
    .map((label) => typeof label === 'string' ? label : (label.name ?? ''))
    .filter(Boolean)
    .sort();
}

function boardMergeHead(targetVersion: string | null): string {
  const head = targetVersion?.split(':', 1)[0];
  if (!head) throw new Error('prepared merge is missing its reviewed pull-request head');
  return head;
}

function reviewedHead(targetVersion: string | null): string {
  const head = targetVersion?.split(':', 1)[0];
  if (!head) throw new Error('prepared action is missing its reviewed pull-request head');
  return head;
}

/** GitHub suggestions are fenced Markdown; lengthening the fence keeps code containing backticks valid. */
function reviewCommentBody(body: string, suggestion?: string): string {
  if (suggestion === undefined) return body;
  const longest = Math.max(0, ...[...suggestion.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${body}\n\n${fence}suggestion\n${suggestion}\n${fence}`;
}
