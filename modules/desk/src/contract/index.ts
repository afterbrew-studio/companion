import '@companion/module-automations/contract';
import '@companion/module-code/contract';
import '@companion/module-core/contract';
import '@companion/module-operate/contract';
import '@companion/module-slop/contract';
import '@companion/module-workbench/contract';
import '@companion/module-workspace/contract';
import type { AskRequest } from '@moxxy/companion-sdk/agents';
import type { RunRecord } from '@companion/module-operate/contract';
import type { DeskService } from '../api/desk-service.js';

declare module '@moxxy/companion-contracts' {
  interface ServerMessageRegistry {
    'desk.missions.changed': Record<never, never>;
    'desk.launch-plans.changed': Record<never, never>;
  }
  interface ServiceMap {
    desk: DeskService;
  }
}

export type DeskContextKind = 'pull-request' | 'issue';
export type DeskMissionKind = 'mission' | 'terminal';

/** A visible, typed reference. GitHub prose is fetched on demand and never
 * embedded in the mission scope prompt. */
export interface DeskContextRef {
  readonly kind: DeskContextKind;
  readonly repo: string;
  readonly number: number;
}

export interface DeskMissionRecord {
  readonly id: string;
  readonly kind: DeskMissionKind;
  readonly title: string;
  readonly workspaceId: string;
  /** Primary repository; null means the whole workspace. */
  readonly repo: string | null;
  /** Preferred machine captured at creation; null keeps automatic placement. */
  readonly runnerId: string | null;
  /** Preferred agent runtime captured with the machine; null keeps automatic selection. */
  readonly harness: string | null;
  readonly contexts: readonly DeskContextRef[];
  readonly runId: string | null;
  readonly archived: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** One mission plus its live execution projection, batched by the server so
 * the mission switcher never performs one request per row. */
export interface DeskMissionView {
  readonly mission: DeskMissionRecord;
  readonly run: RunRecord | null;
  readonly pendingAsks: readonly AskRequest[];
}

/** Durable scope and execution lane for the workspace Terminal. Omitting repo
 * preserves its current scope; null explicitly selects the whole workspace. */
export interface DeskTerminalRequest {
  readonly workspaceId: string;
  readonly repo?: string | null;
  readonly runnerId?: string | null;
  readonly harness?: string | null;
}

export interface DeskMissionLaunchSpec {
  readonly title: string;
  readonly prompt: string;
  /** Primary repository; null keeps the mission at workspace scope. */
  readonly repo: string | null;
  readonly contexts: readonly DeskContextRef[];
}

export type DeskLaunchPlanStatus = 'pending' | 'executing' | 'completed' | 'failed' | 'cancelled' | 'expired';

/** A bounded batch proposed by the delegated Terminal agent. Only an ordinary
 * browser session may confirm it and start the independent missions. */
export interface DeskLaunchPlanRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly missions: readonly DeskMissionLaunchSpec[];
  readonly status: DeskLaunchPlanStatus;
  readonly missionIds: readonly string[];
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly executedAt: number | null;
  readonly error: string | null;
}
