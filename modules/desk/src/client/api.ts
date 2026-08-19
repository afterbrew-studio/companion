import { patch, post, qs, request } from '@moxxy/companion-sdk/client';
import type { AskRequest, HistorySegment } from '@moxxy/companion-sdk/agents';
import type { DeskContextRef, DeskMissionView } from '../contract/index.js';

export const deskApi = {
  missions: (archived = false) =>
    request<{ missions: DeskMissionView[] }>(`/api/desk/missions${qs({ archived: archived ? 1 : undefined })}`),
  mission: (id: string) => request<DeskMissionView>(`/api/desk/missions/${id}`),
  createMission: (body: {
    readonly title?: string;
    readonly workspaceId: string;
    readonly repo?: string | null;
    readonly runnerId?: string | null;
    readonly harness?: string | null;
    readonly contexts?: readonly DeskContextRef[];
  }) => post<DeskMissionView>('/api/desk/missions', body),
  updateMission: (
    id: string,
    body: {
      readonly title?: string;
      readonly repo?: string | null;
      readonly runnerId?: string | null;
      readonly harness?: string | null;
      readonly contexts?: readonly DeskContextRef[];
      readonly archived?: boolean;
    },
  ) => patch<DeskMissionView>(`/api/desk/missions/${id}`, body),
  sendMessage: (id: string, text: string) =>
    post<{ turnId: string; runId: string }>(`/api/desk/missions/${id}/message`, { text }),
  ensureSession: (id: string) => post<DeskMissionView>(`/api/desk/missions/${id}/session`),
  history: (id: string, before: number | null, limit = 300) =>
    request<HistorySegment>(`/api/desk/missions/${id}/history${qs({ before: before ?? undefined, limit })}`),
  respondAsk: (id: string, requestId: string, response: Record<string, unknown>) =>
    post<{ ok: true }>(`/api/desk/missions/${id}/ask`, { requestId, response }),
  abort: (id: string) => post<{ ok: true }>(`/api/desk/missions/${id}/abort`),
};

export type DeskPendingAsk = AskRequest;
