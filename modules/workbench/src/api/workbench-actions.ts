import { createHash, randomUUID } from 'node:crypto';
import type { AuthUser, ServiceMap } from '@moxxy/companion-contracts';
import { badRequest, notFound } from '@moxxy/companion-sdk/server';
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
    private readonly changed: (username: string) => void,
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
    this.changed(user.username);
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
    this.changed(user.username);

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
    this.changed(user.username);
    return this.store.get(id)!;
  }

  cancel(user: AuthUser, id: string): PreparedWorkbenchAction {
    const action = this.requireOwned(user, id);
    if (action.status !== 'pending') throw badRequest(`action is ${action.status}, not pending`);
    if (action.expiresAt <= Date.now()) {
      if (this.store.expire() > 0) this.changed(user.username);
      throw badRequest('action expired');
    }
    if (!this.store.cancel(id, user.username)) throw badRequest(`action is ${action.status}, not pending`);
    this.changed(user.username);
    return this.store.get(id)!;
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
  type: 'string' | 'integer' | 'boolean',
  required: boolean,
  description: string,
  options?: readonly string[],
): WorkbenchActionDefinition['arguments'][number] {
  return { name, type, required, description, ...(options ? { options } : {}) };
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function boardMergeHead(targetVersion: string | null): string {
  const head = targetVersion?.split(':', 1)[0];
  if (!head) throw new Error('prepared merge is missing its reviewed pull-request head');
  return head;
}
