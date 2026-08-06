import type { Database } from '@moxxy/companion-sdk/server';
import type { JiraIssueSnapshot, JiraLinkRecord, JiraSubjectRef } from '../contract/index.js';

interface JiraLinkRow {
  id: string;
  connection_id: string;
  workspace_id: string;
  subject_kind: JiraSubjectRef['kind'];
  repo: string;
  subject_number: number;
  issue_key: string;
  issue_summary: string;
  issue_status: string;
  status_category: string | null;
  issue_type: string;
  issue_url: string;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export class JiraStore {
  constructor(private readonly db: Database) {}

  list(workspaceId: string, subject: JiraSubjectRef): JiraLinkRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM jira_links
           WHERE workspace_id = ? AND subject_kind = ? AND repo = ? AND subject_number = ?
           ORDER BY updated_at DESC, id`,
        )
        .all(workspaceId, subject.kind, subject.repo, subject.number) as JiraLinkRow[]
    ).map(rowToLink);
  }

  get(id: string): JiraLinkRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM jira_links WHERE id = ?`).get(id) as JiraLinkRow | undefined;
    return row ? rowToLink(row) : undefined;
  }

  find(
    workspaceId: string,
    subject: JiraSubjectRef,
    connectionId: string,
    issueKey: string,
  ): JiraLinkRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM jira_links
         WHERE connection_id = ? AND workspace_id = ? AND subject_kind = ? AND repo = ?
           AND subject_number = ? AND issue_key = ?`,
      )
      .get(connectionId, workspaceId, subject.kind, subject.repo, subject.number, issueKey) as JiraLinkRow | undefined;
    return row ? rowToLink(row) : undefined;
  }

  insert(link: JiraLinkRecord): boolean {
    return this.db
      .prepare(
        `INSERT OR IGNORE INTO jira_links
          (id, connection_id, workspace_id, subject_kind, repo, subject_number, issue_key, issue_summary, issue_status,
           status_category, issue_type, issue_url, created_by, created_at, updated_at)
         VALUES
          (@id, @connectionId, @workspaceId, @subjectKind, @repo, @subjectNumber, @issueKey, @issueSummary, @issueStatus,
           @statusCategory, @issueType, @issueUrl, @createdBy, @createdAt, @updatedAt)`,
      )
      .run(linkParams(link)).changes > 0;
  }

  updateIssue(id: string, issue: JiraIssueSnapshot): void {
    this.db
      .prepare(
        `UPDATE jira_links SET issue_key = ?, issue_summary = ?, issue_status = ?, status_category = ?,
                               issue_type = ?, issue_url = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(issue.key, issue.summary, issue.status, issue.statusCategory, issue.issueType, issue.url, Date.now(), id);
  }

  delete(id: string): boolean {
    return this.db.prepare(`DELETE FROM jira_links WHERE id = ?`).run(id).changes > 0;
  }
}

function rowToLink(row: JiraLinkRow): JiraLinkRecord {
  return {
    id: row.id,
    connectionId: row.connection_id,
    workspaceId: row.workspace_id,
    subject: { kind: row.subject_kind, repo: row.repo, number: row.subject_number },
    issue: {
      key: row.issue_key,
      summary: row.issue_summary,
      status: row.issue_status,
      statusCategory: row.status_category,
      issueType: row.issue_type,
      url: row.issue_url,
    },
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function linkParams(link: JiraLinkRecord): Record<string, unknown> {
  return {
    id: link.id,
    connectionId: link.connectionId,
    workspaceId: link.workspaceId,
    subjectKind: link.subject.kind,
    repo: link.subject.repo,
    subjectNumber: link.subject.number,
    issueKey: link.issue.key,
    issueSummary: link.issue.summary,
    issueStatus: link.issue.status,
    statusCategory: link.issue.statusCategory,
    issueType: link.issue.issueType,
    issueUrl: link.issue.url,
    createdBy: link.createdBy,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
  };
}
