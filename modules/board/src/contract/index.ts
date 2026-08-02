// Import the contract of every module we depend on so their augmentations
// (permissions, services, messages) are visible in this compilation.
import '@companion/module-workspace/contract';
import '@companion/module-code/contract';
import type { ChecksSnapshot } from '@companion/module-code/contract';
import '@companion/module-operate/contract';
import type { CatalogModel } from '@companion/module-operate/contract';
import '@companion/module-plan/contract';
import type { BoardService } from '../api/board-service.js';

declare module '@moxxy/companion-contracts' {
  interface PermissionRegistry {
    'board:read': true;
    'board:manage': true;
  }
  interface ServerMessageRegistry {
    'board.changed': Record<never, never>;
  }
  interface ServiceMap {
    board: BoardService;
  }
}

/** Kanban column. Machine-driven except backlog/ready/done↔human moves. */
export type TaskStatus = 'backlog' | 'ready' | 'in_progress' | 'in_review' | 'done' | 'failed';

/**
 * Sub-state within a column. In `ready`/`in_progress` it names the kind of
 * work queued/running (fresh build, addressing review feedback, repairing CI);
 * in `in_review` it names the position in the review cycle.
 */
export type TaskStage =
  | 'build'
  | 'address_review'
  | 'fix_ci'
  | 'awaiting_review'
  | 'reviewing'
  | 'awaiting_merge';

/** P0 (urgent) … P3 (someday). Dispatch order is priority, then age. */
export type TaskPriority = 0 | 1 | 2 | 3;

export type WorkerRole = 'developer' | 'reviewer';

export interface WorkerRecord {
  readonly id: string;
  /** The workspace this worker serves — boards are workspace-scoped. */
  readonly workspaceId: string;
  readonly name: string;
  readonly role: WorkerRole;
  readonly enabled: boolean;
  readonly createdAt: number;
}

/** Worker + its live occupancy (a worker builds at most one task at a time). */
export interface WorkerView extends WorkerRecord {
  readonly busy: boolean;
  /** Task identity is redacted (null) when it lives in a workspace the caller cannot access. */
  readonly busyTaskId: string | null;
  readonly busyTaskTitle: string | null;
  readonly busyTaskRepo: string | null;
}

/** An image attached to a task and sent with the worker's first prompt. */
export interface TaskAttachment {
  readonly id: string;
  readonly name: string;
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  /** Base64 image bytes; null in board snapshots and present in task detail. */
  readonly content: string | null;
}

export interface TaskAttachmentInput {
  readonly name: string;
  readonly mediaType: TaskAttachment['mediaType'];
  readonly content: string;
}

export interface TaskRecord {
  readonly id: string;
  /** Workspace board that owns this task, independent of other memberships of the repo. */
  readonly workspaceId: string;
  readonly repo: string;
  /** Branch the worker starts from and the resulting PR targets. */
  readonly targetBranch: string;
  readonly title: string;
  readonly description: string;
  /** Definition of done: acceptance criteria the build must satisfy. */
  readonly acceptance: string;
  /** Optional plan-module spec attached as agent context. */
  readonly specId: string | null;
  readonly attachments: readonly TaskAttachment[];
  /** Prerequisite tasks: dispatch holds this task until every one is done. */
  readonly dependsOn: readonly string[];
  /**
   * Model every run this card spawns rides. null = inherit, which is the
   * `board.worker` pin (and the daemon default under it) resolved per run, so
   * changing that pin still moves every card that never chose for itself.
   * Editable mid-flight: the change reaches the card's NEXT run, since a run
   * already dispatched is bound to the machine and model it started on.
   */
  readonly model: string | null;
  readonly priority: TaskPriority;
  readonly status: TaskStatus;
  readonly stage: TaskStage | null;
  /** Username of the human who created the task. */
  readonly createdBy: string | null;
  /** Name snapshot of the first worker to pick this up (survives worker deletion). */
  readonly firstWorker: string | null;
  /** Sticky assignment: kept across the review cycle so feedback binds back. */
  readonly assignedWorkerId: string | null;
  /** The currently-active agent run, if any. */
  readonly runId: string | null;
  readonly branch: string | null;
  readonly prNumber: number | null;
  readonly prUrl: string | null;
  /** Latest AI review verdict on the task's PR (null until reviewed). */
  readonly reviewRisk: 'low' | 'medium' | 'high' | null;
  readonly reviewRecommendation: 'approve' | 'request_changes' | 'comment' | null;
  /** Remediation cycles consumed (build failures, CI fixes, review rounds). */
  readonly attempts: number;
  readonly lastError: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}

/** Kanban card projection; long authoring fields are fetched in task detail. */
export type TaskListRecord = Omit<TaskRecord, 'description' | 'acceptance'>;

/** A prerequisite in the task detail — title redacted when the caller can't see its repo. */
export interface TaskDependencyView {
  readonly id: string;
  readonly title: string | null;
  readonly status: TaskStatus;
}

/** The task's PR as GitHub sees it (from the code module's sync cache). */
export interface TaskPrView {
  readonly state: 'open' | 'closed' | 'merged';
  readonly reviewDecision: 'approved' | 'changes_requested' | null;
  readonly checks: ChecksSnapshot | null;
}

/** Timeline entry on a task — who did what, when. */
export interface TaskEventRecord {
  readonly id: number;
  readonly taskId: string;
  readonly at: number;
  readonly kind: string;
  readonly detail: string;
}

export interface BoardConfig {
  /** Reviewer worker reviews every PR that lands in the review column. */
  readonly autoReview: boolean;
  /** Pinned reviewer; null = automatic resolution among the workspace's enabled reviewer workers. */
  readonly reviewerWorkerId: string | null;
  /** Merge automatically once review approves and checks are green. */
  readonly autoMerge: boolean;
  readonly mergeMethod: 'merge' | 'squash' | 'rebase';
  /** @deprecated Storage compatibility only; always null. Merges use the task owner's account. */
  readonly mergeAccountId: string | null;
  /** Failing checks on a task's PR send it back to its worker. */
  readonly autoFixCi: boolean;
  /** Remediation ceiling before the task drops into the Failed column. */
  readonly maxAttempts: number;
}

/** Spec picker option (soft plan dependency — empty when plan is disabled). */
export interface SpecOption {
  readonly id: string;
  readonly title: string;
}

/**
 * What a card's model picker may offer, and what leaving it unset means. Read
 * straight off operate's runner catalog and the `board.worker` pin, so there is
 * no second list to keep in step with the Task models settings page.
 */
export interface TaskModelOptions {
  /**
   * Models some enabled SHARED machine is capable of serving. Capability, not
   * availability: board work never places on personal machines, and a card
   * outlives any one machine being offline or busy.
   */
  readonly models: ReadonlyArray<CatalogModel>;
  /** The `board.worker` pin an unset card inherits; null = no pin, so the daemon default applies. */
  readonly workerModel: string | null;
  /** The daemon default, under everything else. */
  readonly defaultModel: string;
}
