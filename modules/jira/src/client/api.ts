import { del, post, request } from '@moxxy/companion-sdk/client';
import type { JiraLinkRecord, JiraSubjectRef, JiraTransition } from '../contract/index.js';

function subjectQuery(subject: JiraSubjectRef, workspaceId: string): string {
  return new URLSearchParams({
    kind: subject.kind,
    repo: subject.repo,
    number: String(subject.number),
    workspaceId,
  }).toString();
}

export const jiraApi = {
  links: (subject: JiraSubjectRef, workspaceId: string) =>
    request<{ links: readonly JiraLinkRecord[] }>(`/api/jira/links?${subjectQuery(subject, workspaceId)}`),
  link: (subject: JiraSubjectRef, workspaceId: string, connectionId: string, issueKey: string) =>
    post<{ link: JiraLinkRecord }>('/api/jira/links', { subject, workspaceId, connectionId, issueKey }),
  unlink: (id: string, workspaceId: string) =>
    del<{ ok: true }>(`/api/jira/links/${encodeURIComponent(id)}?${new URLSearchParams({ workspaceId })}`),
  refresh: (id: string, workspaceId: string) =>
    post<{ link: JiraLinkRecord }>(`/api/jira/links/${encodeURIComponent(id)}/refresh`, { workspaceId }),
  comment: (id: string, workspaceId: string, body: string) =>
    post<{ link: JiraLinkRecord }>(`/api/jira/links/${encodeURIComponent(id)}/comments`, { workspaceId, body }),
  transitions: (id: string, workspaceId: string) =>
    request<{ transitions: readonly JiraTransition[] }>(
      `/api/jira/links/${encodeURIComponent(id)}/transitions?${new URLSearchParams({ workspaceId })}`,
    ),
  transition: (id: string, workspaceId: string, transitionId: string) =>
    post<{ link: JiraLinkRecord }>(`/api/jira/links/${encodeURIComponent(id)}/transitions`, {
      workspaceId,
      transitionId,
    }),
};
