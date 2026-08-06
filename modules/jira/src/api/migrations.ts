import { defineMigrations } from '@moxxy/companion-sdk/server';

export default defineMigrations([
  {
    version: 1,
    name: 'jira_links',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS jira_links (
          id               TEXT PRIMARY KEY,
          connection_id    TEXT NOT NULL,
          workspace_id     TEXT NOT NULL,
          subject_kind     TEXT NOT NULL,
          repo             TEXT NOT NULL,
          subject_number   INTEGER NOT NULL,
          issue_key        TEXT NOT NULL,
          issue_summary    TEXT NOT NULL,
          issue_status     TEXT NOT NULL,
          status_category  TEXT,
          issue_type       TEXT NOT NULL,
          issue_url        TEXT NOT NULL,
          created_by       TEXT NOT NULL,
          created_at       INTEGER NOT NULL,
          updated_at       INTEGER NOT NULL,
          UNIQUE(connection_id, workspace_id, subject_kind, repo, subject_number, issue_key)
        );
        CREATE INDEX IF NOT EXISTS idx_jira_links_subject
          ON jira_links(workspace_id, subject_kind, repo, subject_number, updated_at DESC);
      `);
    },
    down: (db) => {
      db.exec(`DROP TABLE IF EXISTS jira_links`);
    },
  },
]);
