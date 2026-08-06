import { randomUUID } from 'node:crypto';
import type { ServiceMap, SpaServerMessage } from '@moxxy/companion-contracts';
import type { IntegrationScope } from '@companion/module-integrations/contract';
import type { JiraLinkRecord, JiraSubjectRef, JiraTransition } from '../contract/index.js';
import { JiraCloudClient, normalizeIssueKey } from './jira-client.js';
import { JiraStore } from './jira-store.js';

export class JiraService {
  constructor(
    private readonly store: JiraStore,
    private readonly integrations: ServiceMap['integrations'],
    private readonly broadcast: (message: SpaServerMessage) => void,
  ) {}

  list(workspaceId: string, subject: JiraSubjectRef): JiraLinkRecord[] {
    return this.store.list(workspaceId, subject);
  }

  async link(
    subject: JiraSubjectRef,
    scope: IntegrationScope,
    connectionId: string,
    issueKey: string,
    userId: string,
  ): Promise<JiraLinkRecord> {
    if (scope.kind !== 'repository') throw new Error('Jira links require a repository scope');
    const normalizedKey = normalizeIssueKey(issueKey);
    const existing = this.store.find(scope.workspaceId, subject, connectionId, normalizedKey);
    if (existing) return existing;
    const client = this.client(scope, connectionId, userId);
    const issue = await client.issue(normalizedKey);
    const now = Date.now();
    const link: JiraLinkRecord = {
      id: `jl-${randomUUID().slice(0, 12)}`,
      connectionId,
      workspaceId: scope.workspaceId,
      subject,
      issue,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    };
    if (!this.store.insert(link)) {
      const winner = this.store.find(scope.workspaceId, subject, connectionId, issue.key);
      if (!winner) throw new Error('Jira link changed while it was being created; try again');
      return winner;
    }
    this.changed(scope.workspaceId, subject);
    return link;
  }

  unlink(id: string): JiraLinkRecord {
    const link = this.requireLink(id);
    this.store.delete(id);
    this.changed(link.workspaceId, link.subject);
    return link;
  }

  async refresh(id: string, scope: IntegrationScope, userId: string): Promise<JiraLinkRecord> {
    const link = this.requireLink(id);
    const issue = await this.client(scope, link.connectionId, userId).issue(link.issue.key);
    this.store.updateIssue(id, issue);
    this.changed(link.workspaceId, link.subject);
    return this.requireLink(id);
  }

  async comment(id: string, scope: IntegrationScope, userId: string, body: string): Promise<JiraLinkRecord> {
    const link = this.requireLink(id);
    await this.client(scope, link.connectionId, userId).comment(link.issue.key, body);
    return this.refresh(id, scope, userId);
  }

  async transitions(id: string, scope: IntegrationScope, userId: string): Promise<JiraTransition[]> {
    const link = this.requireLink(id);
    return this.client(scope, link.connectionId, userId).transitions(link.issue.key);
  }

  async transition(
    id: string,
    scope: IntegrationScope,
    userId: string,
    transitionId: string,
  ): Promise<JiraLinkRecord> {
    const link = this.requireLink(id);
    await this.client(scope, link.connectionId, userId).transition(link.issue.key, transitionId);
    return this.refresh(id, scope, userId);
  }

  requireLink(id: string): JiraLinkRecord {
    const link = this.store.get(id);
    if (!link) throw new Error('Jira link not found');
    return link;
  }

  private client(scope: IntegrationScope, connectionId: string, userId: string): JiraCloudClient {
    const [target] = this.integrations.resolveTargets(
      'issue-tracking',
      scope,
      { providerId: 'jira.cloud', connectionId },
      userId,
    );
    if (!target?.connection) throw new Error('Jira Cloud connection is unavailable');
    return new JiraCloudClient(target.connection);
  }

  private changed(workspaceId: string, subject: JiraSubjectRef): void {
    this.broadcast({ t: 'jira.changed', workspaceId, kind: subject.kind, repo: subject.repo, number: subject.number });
  }
}
