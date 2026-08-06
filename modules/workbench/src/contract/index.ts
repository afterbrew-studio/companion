// Hard dependencies: identity/RBAC, workspace scope, runs and GitHub data.
import '@companion/module-core/contract';
import '@companion/module-workspace/contract';
import '@companion/module-operate/contract';
import '@companion/module-code/contract';
// Soft runtime dependencies: Board contributes decisions; Plan owns optional
// requirement and knowledge actions when those areas are enabled.
import '@companion/module-board/contract';
import '@companion/module-plan/contract';
import type { Permission } from '@moxxy/companion-contracts';
import type { WorkbenchService } from '../api/workbench-service.js';

declare module '@moxxy/companion-contracts' {
  interface PermissionRegistry {
    'workbench:read': true;
  }
  interface ServerMessageRegistry {
    /** A prepared action changed for the current profile. */
    'workbench.actions.changed': Record<never, never>;
  }
  interface ServiceMap {
    /** Read-only composition of the decisions already owned by feature domains. */
    workbench: WorkbenchService;
  }
}

/** The decision the human must make, not the subsystem that happened to raise it. */
export type DecisionKind =
  | 'agent-change'
  | 'pull-request-review'
  | 'issue-triage'
  | 'board-merge'
  | 'board-failure';

/** Stable identity of the owning domain object; future actions resolve through this. */
export type DecisionSubject =
  | { readonly type: 'run'; readonly id: string; readonly repo: string | null }
  | { readonly type: 'pull-request'; readonly repo: string; readonly number: number }
  | { readonly type: 'issue'; readonly repo: string; readonly number: number }
  | { readonly type: 'task'; readonly id: string; readonly repo: string }
  | { readonly type: 'content'; readonly area: 'specification' | 'documentation'; readonly repo: string | null };

/**
 * One human decision projected from an owning domain. It carries no copied
 * state beyond what the queue renders; opening `href` reads the authoritative
 * detail and performs the action in that domain.
 */
export interface DecisionItem {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: DecisionKind;
  readonly subject: DecisionSubject;
  readonly title: string;
  /** Why this object stopped and needs a person now. */
  readonly reason: string;
  /** Short verb phrase shown at the edge, e.g. "Review findings". */
  readonly nextAction: string;
  readonly href: string;
  readonly updatedAt: number;
}

/** Bounded snapshot of the current workspace's decision queue. */
export interface DecisionSnapshot {
  readonly items: ReadonlyArray<DecisionItem>;
  /** At least one source has more rows than this bounded response carries. */
  readonly hasMore: boolean;
}

/** Mutations the platform assistant and programmatic clients may propose. */
export type WorkbenchActionRequest =
  | {
      readonly action: 'run.approve';
      readonly runId: string;
      readonly title?: string;
      readonly body?: string;
    }
  | { readonly action: 'run.discard'; readonly runId: string }
  | {
      readonly action: 'pr-review.apply';
      readonly repo: string;
      readonly number: number;
      readonly mode?: 'full' | 'comments' | 'summary';
    }
  | { readonly action: 'pr-review.dismiss'; readonly repo: string; readonly number: number }
  | {
      readonly action: 'issue-triage.apply';
      readonly repo: string;
      readonly number: number;
      readonly comment?: boolean;
    }
  | { readonly action: 'issue-triage.dismiss'; readonly repo: string; readonly number: number }
  | { readonly action: 'board.merge'; readonly taskId: string }
  | { readonly action: 'board.retry'; readonly taskId: string }
  | {
      readonly action: 'spec.create';
      readonly repo: string;
      readonly title: string;
      readonly content: string;
    }
  | {
      readonly action: 'doc.create';
      readonly repo?: string;
      readonly title: string;
      readonly content: string;
    };

export type WorkbenchActionId = WorkbenchActionRequest['action'];
export type WorkbenchActionStatus = 'pending' | 'executing' | 'completed' | 'failed' | 'cancelled' | 'expired';
export type WorkbenchActionSource = 'assistant' | 'mcp' | 'ui';
export type WorkbenchActionImpact = 'local' | 'external' | 'destructive';

/** Machine-readable argument metadata; the MCP adapter derives its tool schemas from this. */
export interface WorkbenchActionArgument {
  readonly name: string;
  readonly type: 'string' | 'integer' | 'boolean';
  readonly required: boolean;
  readonly description: string;
  readonly options?: readonly string[];
}

/** One action exposed consistently to AI Help, the SPA, and programmatic clients. */
export interface WorkbenchActionDefinition {
  readonly id: WorkbenchActionId;
  readonly title: string;
  readonly description: string;
  /** All are enforced by the router before preparation and execution. */
  readonly access: readonly [Permission, ...Permission[]];
  readonly impact: WorkbenchActionImpact;
  readonly arguments: readonly WorkbenchActionArgument[];
}

export interface WorkbenchActionResult {
  readonly message: string;
  readonly href: string;
}

/**
 * Durable proposal produced by an untrusted delegate and confirmed by a human.
 * The resolved domain row stays server-side; execution revalidates it before writing.
 */
export interface PreparedWorkbenchAction {
  readonly id: string;
  readonly workspaceId: string;
  readonly requestedBy: string;
  readonly source: WorkbenchActionSource;
  readonly request: WorkbenchActionRequest;
  readonly subject: DecisionSubject;
  readonly title: string;
  readonly summary: string;
  readonly consequence: string;
  readonly impact: WorkbenchActionImpact;
  readonly href: string;
  readonly status: WorkbenchActionStatus;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly executedAt: number | null;
  readonly error: string | null;
  readonly result: WorkbenchActionResult | null;
}
