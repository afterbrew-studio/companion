import '@companion/module-automations/contract';
import '@companion/module-code/contract';
import '@companion/module-core/contract';
import '@companion/module-operate/contract';
import '@companion/module-workbench/contract';
import '@companion/module-workspace/contract';
import type { AskRequest } from '@moxxy/companion-sdk/agents';
import type { RunRecord } from '@companion/module-operate/contract';
import type { DeskService } from '../api/desk-service.js';

declare module '@moxxy/companion-contracts' {
  interface ServerMessageRegistry {
    'desk.missions.changed': Record<never, never>;
  }
  interface ServiceMap {
    desk: DeskService;
  }
}

export type DeskContextKind = 'pull-request' | 'issue';

/** A visible, typed reference. GitHub prose is fetched on demand and never
 * embedded in the mission scope prompt. */
export interface DeskContextRef {
  readonly kind: DeskContextKind;
  readonly repo: string;
  readonly number: number;
}

export interface DeskMissionRecord {
  readonly id: string;
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
