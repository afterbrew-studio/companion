import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLive } from '@moxxy/companion-sdk/client';
import { useAuth } from '@companion/module-core/client';
import { useIntegrations } from '@companion/module-integrations/client';
import type { IntegrationConnectionRecord, IntegrationScope } from '@companion/module-integrations/contract';
import { useWorkspace } from '@companion/module-workspace/client';
import {
  EmptyState,
  ErrorBar,
  Field,
  FormActions,
  MetaSignal,
  Modal,
  Spinner,
  useConfirm,
} from '@moxxy/companion-sdk/ui';
import type { JiraLinkRecord, JiraSubjectRef, JiraTransition } from '../contract/index.js';
import { jiraApi } from './api.js';

export function JiraLinks({ subject }: { subject: JiraSubjectRef }): JSX.Element | null {
  const { can } = useAuth();
  const { current } = useWorkspace();
  const integrations = useIntegrations();
  const [links, setLinks] = useState<readonly JiraLinkRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [commenting, setCommenting] = useState<JiraLinkRecord | null>(null);
  const [moving, setMoving] = useState<{ link: JiraLinkRecord; transitions: readonly JiraTransition[] } | null>(null);
  const { confirmDanger, confirmElement } = useConfirm();
  const workspaceId = current?.id ?? null;
  const subjectKey = `${workspaceId ?? ''}:${subject.kind}:${subject.repo}:${subject.number}`;

  useEffect(() => {
    setLinks(null);
    setError(null);
    setAdding(false);
    setCommenting(null);
    setMoving(null);
  }, [subjectKey]);

  const refresh = useCallback(async (): Promise<void> => {
    if (!workspaceId) return;
    try {
      const response = await jiraApi.links(subject, workspaceId);
      setLinks(response.links);
      setError(null);
    } catch (err) {
      setError(messageOf(err));
    }
  }, [subject.kind, subject.repo, subject.number, workspaceId]);
  useLive(refresh, (message) =>
    message.t === 'jira.changed' &&
    message.workspaceId === workspaceId &&
    message.kind === subject.kind &&
    message.repo === subject.repo &&
    message.number === subject.number,
  );

  const scope: IntegrationScope | null = workspaceId
    ? { kind: 'repository', workspaceId, repo: subject.repo }
    : null;
  const connections = useMemo(
    () => (scope ? (integrations.catalog?.connections ?? []).filter((connection) =>
      connection.providerId === 'jira.cloud' && connection.enabled && applies(connection, scope),
    ) : []),
    [integrations.catalog, scope ? `${scope.workspaceId}:${scope.repo}` : ''],
  );

  if (!workspaceId || links === null || !integrations.catalog) {
    if (error || integrations.error) return <ErrorBar error={error ?? integrations.error} />;
    return null;
  }
  // With nothing linked, the card is worth its space only to someone who could
  // link something right now. Otherwise Jira is not part of this repository's
  // work — and admins, the only ones who used to see it, were being pitched a
  // product on a page they opened to read a pull request.
  if (links.length === 0 && (connections.length === 0 || !can('jira:act'))) return null;

  const run = async (key: string, operation: () => Promise<unknown>): Promise<void> => {
    setBusy(key);
    setError(null);
    try {
      await operation();
      await refresh();
    } catch (err) {
      setError(messageOf(err));
      throw err;
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card mt-4 overflow-hidden p-0" aria-label="Linked Jira tickets">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div>
          <h2 className="text-sm font-semibold">Linked Jira tickets</h2>
          <p className="dim mt-0.5 text-xs">Keep delivery context beside the GitHub work.</p>
        </div>
        <span className="flex-1" />
        {can('jira:act') && connections.length > 0 ? (
          <button className="btn-ghost" onClick={() => setAdding(true)}>Link ticket</button>
        ) : null}
        {can('integrations:manage') ? (
          <a className="btn-ghost" href={`#/repos/${subject.repo}/integrations`}>Configure Jira</a>
        ) : null}
      </div>

      <ErrorBar error={error ?? integrations.error} />
      {links.length === 0 ? (
        <div className="flex flex-col items-center gap-1.5 px-4 py-7 text-center">
          <p className="text-sm font-medium">No ticket linked</p>
          <p className="dim max-w-md text-sm">Link the Jira ticket that owns or tracks this work.</p>
          <button className="btn mt-2" onClick={() => setAdding(true)}>Link Jira ticket</button>
        </div>
      ) : (
        <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {links.map((link) => (
            <JiraLinkRow
              key={link.id}
              link={link}
              connection={integrations.catalog!.connections.find((candidate) => candidate.id === link.connectionId)}
              canAct={can('jira:act')}
              busy={busy === link.id}
              onRefresh={() => void run(link.id, () => jiraApi.refresh(link.id, workspaceId)).catch(() => undefined)}
              onComment={() => setCommenting(link)}
              onMove={() => void run(link.id, async () => {
                const result = await jiraApi.transitions(link.id, workspaceId);
                setMoving({ link, transitions: result.transitions });
              }).catch(() => undefined)}
              onUnlink={() => void (async () => {
                const confirmed = await confirmDanger({
                  title: `Unlink ${link.issue.key}?`,
                  message: 'The Jira ticket itself is not changed. Only this Companion link is removed.',
                  confirmLabel: 'Unlink ticket',
                });
                if (confirmed) await run(link.id, () => jiraApi.unlink(link.id, workspaceId));
              })().catch(() => undefined)}
            />
          ))}
        </div>
      )}

      {adding ? (
        <LinkTicketModal
          connections={connections}
          busy={busy === 'link'}
          onClose={() => setAdding(false)}
          onSubmit={async (connectionId, issueKey) => {
            await run('link', () => jiraApi.link(subject, workspaceId, connectionId, issueKey));
            setAdding(false);
          }}
        />
      ) : null}
      {commenting ? (
        <CommentModal
          link={commenting}
          busy={busy === commenting.id}
          onClose={() => setCommenting(null)}
          onSubmit={async (body) => {
            await run(commenting.id, () => jiraApi.comment(commenting.id, workspaceId, body));
            setCommenting(null);
          }}
        />
      ) : null}
      {moving ? (
        <TransitionModal
          link={moving.link}
          transitions={moving.transitions}
          busy={busy === moving.link.id}
          onClose={() => setMoving(null)}
          onSubmit={async (transitionId) => {
            await run(moving.link.id, () => jiraApi.transition(moving.link.id, workspaceId, transitionId));
            setMoving(null);
          }}
        />
      ) : null}
      {confirmElement}
    </section>
  );
}

function JiraLinkRow({
  link,
  connection,
  canAct,
  busy,
  onRefresh,
  onComment,
  onMove,
  onUnlink,
}: {
  link: JiraLinkRecord;
  connection: IntegrationConnectionRecord | undefined;
  canAct: boolean;
  busy: boolean;
  onRefresh: () => void;
  onComment: () => void;
  onMove: () => void;
  onUnlink: () => void;
}): JSX.Element {
  const usable = connection?.enabled === true;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <a className="linkish font-medium" href={link.issue.url} target="_blank" rel="noreferrer">
            {link.issue.key} ↗
          </a>
          <MetaSignal tone={statusTone(link.issue.statusCategory)} label={link.issue.status} />
          <span className="dim text-xs">{link.issue.issueType}</span>
        </div>
        <p className="mt-1 truncate text-sm">{link.issue.summary}</p>
        <p className="dim mt-1 text-[11px]">
          {connection ? `via ${connection.name}${connection.enabled ? '' : ' · connection disabled'}` : 'connection removed'}
        </p>
      </div>
      {busy ? <Spinner /> : null}
      {canAct ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {usable ? <button className="btn-ghost" disabled={busy} onClick={onComment}>Comment</button> : null}
          {usable ? <button className="btn-ghost" disabled={busy} onClick={onMove}>Move</button> : null}
          {usable ? <button className="btn-ghost" disabled={busy} onClick={onRefresh}>Refresh</button> : null}
          <button className="btn-ghost text-red-600 dark:text-red-400" disabled={busy} onClick={onUnlink}>Unlink</button>
        </div>
      ) : null}
    </div>
  );
}

function LinkTicketModal({
  connections,
  busy,
  onClose,
  onSubmit,
}: {
  connections: readonly IntegrationConnectionRecord[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (connectionId: string, issueKey: string) => Promise<void>;
}): JSX.Element {
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? '');
  const [issueKey, setIssueKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="Link Jira ticket" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Field label="Jira connection">
          <select className="input" value={connectionId} onChange={(event) => setConnectionId(event.target.value)}>
            {connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
          </select>
        </Field>
        <Field label="Issue key" hint="For example PLATFORM-142">
          <input className="input uppercase" autoFocus value={issueKey} onChange={(event) => setIssueKey(event.target.value)} placeholder="PROJECT-123" />
        </Field>
        <ErrorBar error={error} />
        <FormActions divider>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={busy || !connectionId || !issueKey.trim()} onClick={() => void onSubmit(connectionId, issueKey).catch((err) => setError(messageOf(err)))}>
            {busy ? 'Linking…' : 'Link ticket'}
          </button>
        </FormActions>
      </div>
    </Modal>
  );
}

function CommentModal({
  link,
  busy,
  onClose,
  onSubmit,
}: {
  link: JiraLinkRecord;
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: string) => Promise<void>;
}): JSX.Element {
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={`Comment on ${link.issue.key}`} onClose={onClose}>
      <Field label="Comment" hint="Posted as plain text by the account configured for this Jira connection.">
        <textarea className="input min-h-32 resize-y" autoFocus value={body} onChange={(event) => setBody(event.target.value)} />
      </Field>
      <ErrorBar error={error} />
      <FormActions divider>
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={busy || !body.trim()} onClick={() => void onSubmit(body.trim()).catch((err) => setError(messageOf(err)))}>
          {busy ? 'Posting…' : 'Post comment'}
        </button>
      </FormActions>
    </Modal>
  );
}

function TransitionModal({
  link,
  transitions,
  busy,
  onClose,
  onSubmit,
}: {
  link: JiraLinkRecord;
  transitions: readonly JiraTransition[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (transitionId: string) => Promise<void>;
}): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={`Move ${link.issue.key}`} onClose={onClose}>
      {transitions.length === 0 ? (
        <EmptyState title="No transitions available" hint="Jira workflow permissions and the current status determine available transitions." />
      ) : (
        <div className="flex flex-col gap-2">
          {transitions.map((transition) => (
            <button
              key={transition.id}
              className="flex items-center gap-3 rounded-lg border border-zinc-200 px-3 py-2.5 text-left hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
              disabled={busy}
              onClick={() => void onSubmit(transition.id).catch((err) => setError(messageOf(err)))}
            >
              <span className="min-w-0 flex-1 text-sm font-medium">{transition.name}</span>
              <MetaSignal tone={statusTone(transition.toCategory)} label={transition.toStatus} />
            </button>
          ))}
        </div>
      )}
      <ErrorBar error={error} />
      <FormActions divider><button className="btn-ghost" onClick={onClose}>Cancel</button></FormActions>
    </Modal>
  );
}

function applies(connection: IntegrationConnectionRecord, scope: Extract<IntegrationScope, { kind: 'repository' }>): boolean {
  if (connection.scope.kind === 'instance') return true;
  if (connection.scope.workspaceId !== scope.workspaceId) return false;
  if (connection.scope.kind === 'workspace') return true;
  return connection.scope.repo === scope.repo;
}

function statusTone(category: string | null): 'green' | 'blue' | 'zinc' {
  const value = category?.toLowerCase() ?? '';
  if (value.includes('done')) return 'green';
  if (value.includes('progress')) return 'blue';
  return 'zinc';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
