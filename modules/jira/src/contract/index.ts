import '@companion/module-integrations/contract';
import '@companion/module-code/contract';
import '@companion/module-workspace/contract';
import type { JiraService } from '../api/jira-service.js';

declare module '@moxxy/companion-contracts' {
  interface PermissionRegistry {
    'jira:read': true;
    'jira:act': true;
  }
  interface ServerMessageRegistry {
    'jira.changed': {
      readonly workspaceId: string;
      readonly kind: JiraSubjectKind;
      readonly repo: string;
      readonly number: number;
    };
  }
  interface ServiceMap {
    jira: JiraService;
  }
}

export type JiraSubjectKind = 'issue' | 'pull-request';

export interface JiraSubjectRef {
  readonly kind: JiraSubjectKind;
  readonly repo: string;
  readonly number: number;
}

export interface JiraIssueSnapshot {
  readonly key: string;
  readonly summary: string;
  readonly status: string;
  readonly statusCategory: string | null;
  readonly issueType: string;
  readonly url: string;
}

export interface JiraLinkRecord {
  readonly id: string;
  readonly connectionId: string;
  readonly workspaceId: string;
  readonly subject: JiraSubjectRef;
  readonly issue: JiraIssueSnapshot;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface JiraTransition {
  readonly id: string;
  readonly name: string;
  readonly toStatus: string;
  readonly toCategory: string | null;
}
