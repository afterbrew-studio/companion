import { useState } from 'react';
import { useAuth } from '@companion/module-core/client';
import { ErrorBar, Eyebrow, ListCard, Markdown, StatusDot, timeAgo } from '@moxxy/companion-sdk/ui';
import type { PreparedWorkbenchAction } from '../../contract/index.js';
import { workbenchApi } from '../api.js';
import { useWorkbenchActions, type WorkbenchActionsFeed } from '../hooks/useWorkbenchActions.js';

/** The human-only half of review-then-apply; delegates can prepare but cannot click this route. */
export function PreparedActions({
  workspaceId,
  compact = false,
}: {
  readonly workspaceId?: string;
  readonly compact?: boolean;
}): React.JSX.Element | null {
  const { can } = useAuth();
  const mayRead = can('workbench:read');
  const feed = useWorkbenchActions(workspaceId, mayRead);
  if (!mayRead) return null;
  return <PreparedActionsView feed={feed} compact={compact} />;
}

/** Shared rendering so Today can count approvals in its single queue summary. */
export function PreparedActionsView({
  feed,
  compact = false,
}: {
  readonly feed: WorkbenchActionsFeed;
  readonly compact?: boolean;
}): React.JSX.Element | null {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (action: PreparedWorkbenchAction, operation: 'execute' | 'cancel'): Promise<void> => {
    setBusy(action.id);
    setError(null);
    try {
      const result = operation === 'execute'
        ? await workbenchApi.executeAction(action.id, action.request.action)
        : await workbenchApi.cancelAction(action.id);
      if (result.action.status === 'failed') setError(result.action.error ?? 'Action failed');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      await feed.refresh();
      setBusy(null);
    }
  };

  if (feed.actions.length === 0 && !feed.error && !error) return null;

  const content = (
    <>
      <ErrorBar error={error ?? feed.error} className="mb-2" />
      {feed.actions.length > 0 ? (
        compact ? <div className="space-y-3">
          {feed.actions.map((action) => (
            <ActionCard
              key={action.id}
              action={action}
              compact
              busy={busy === action.id}
              onExecute={() => void act(action, 'execute')}
              onCancel={() => void act(action, 'cancel')}
            />
          ))}
        </div> : <ListCard>
          {feed.actions.map((action) => (
            <ActionCard
              key={action.id}
              action={action}
              busy={busy === action.id}
              onExecute={() => void act(action, 'execute')}
              onCancel={() => void act(action, 'cancel')}
            />
          ))}
        </ListCard>
      ) : null}
    </>
  );

  if (compact) return <div className="mt-3">{content}</div>;
  return (
    <section aria-labelledby="prepared-actions" className="mb-6">
      <Eyebrow>Approval required</Eyebrow>
      <h2 id="prepared-actions" className="mt-0.5 mb-2 text-sm font-semibold">
        Review what Companion is about to do
      </h2>
      {content}
    </section>
  );
}

function ActionCard({
  action,
  compact = false,
  busy,
  onExecute,
  onCancel,
}: {
  readonly action: PreparedWorkbenchAction;
  readonly compact?: boolean;
  readonly busy: boolean;
  readonly onExecute: () => void;
  readonly onCancel: () => void;
}): React.JSX.Element {
  const content = proposedContent(action);
  const runApproval = action.request.action === 'run.approve' ? action.request : null;
  if (compact) {
    return (
      <CompactActionCard
        action={action}
        busy={busy}
        content={content}
        runApproval={runApproval}
        onExecute={onExecute}
        onCancel={onCancel}
      />
    );
  }
  return (
    <div className="flex items-start gap-3 px-3.5 py-3">
      <StatusDot tone={action.impact === 'destructive' ? 'red' : 'amber'} className="mt-1.5" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-medium">{action.title}</span>
          <span className="dim text-[11px] font-medium tracking-wide uppercase">
            {sourceLabel(action)} · prepared {timeAgo(action.createdAt)} · {expiresIn(action.expiresAt)}
          </span>
        </div>
        <p className="dim mt-0.5 text-xs">{action.summary}</p>
        <p className="mt-1 text-xs">{action.consequence}</p>
        {runApproval && (runApproval.title !== undefined || runApproval.body !== undefined) ? (
          <ProposedPullRequest title={runApproval.title} body={runApproval.body} />
        ) : null}
        {content ? <ProposedContent text={content.text} label={content.label} /> : null}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <a className="btn-ghost" href={action.href}>
            Inspect target
          </a>
          <button className="btn-ghost" type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            className={action.impact === 'destructive' ? 'btn-danger' : 'btn'}
            type="button"
            disabled={busy}
            onClick={onExecute}
          >
            {busy ? 'Applying…' : 'Confirm and apply'}
          </button>
        </div>
      </div>
    </div>
  );
}

function CompactActionCard({
  action,
  busy,
  content,
  runApproval,
  onExecute,
  onCancel,
}: {
  readonly action: PreparedWorkbenchAction;
  readonly busy: boolean;
  readonly content: ReturnType<typeof proposedContent>;
  readonly runApproval: Extract<PreparedWorkbenchAction['request'], { readonly action: 'run.approve' }> | null;
  readonly onExecute: () => void;
  readonly onCancel: () => void;
}): React.JSX.Element {
  const destructive = action.impact === 'destructive';
  return (
    <section
      className={`relative overflow-hidden rounded-xl border bg-white px-4 py-4 shadow-sm dark:bg-zinc-950 ${
        destructive ? 'border-red-200 dark:border-red-500/30' : 'border-amber-200 dark:border-amber-500/30'
      }`}
      aria-label={`Approval required: ${action.title}`}
    >
      <span className={`absolute inset-y-0 left-0 w-0.5 ${destructive ? 'bg-red-500' : 'bg-amber-500'}`} aria-hidden="true" />
      <div className="flex items-start gap-3">
        <StatusDot tone={destructive ? 'red' : 'amber'} className="mt-1.5" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={`text-[10px] font-semibold tracking-wide uppercase ${destructive ? 'text-red-600 dark:text-red-400' : 'text-amber-700 dark:text-amber-400'}`}>
              Approval required
            </span>
            <span className="dim text-[10px]">Prepared by {sourceLabel(action)} · {timeAgo(action.createdAt)}</span>
            <span className="dim ml-auto shrink-0 text-[10px]">{expiresIn(action.expiresAt)}</span>
          </div>
          <h3 className="mt-1 text-sm font-semibold">{action.title}</h3>
          <p className="dim mt-1 text-xs leading-relaxed">{action.summary}</p>
          <p className="mt-3 rounded-lg bg-zinc-50 px-3 py-2 text-xs leading-relaxed text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
            {action.consequence}
          </p>
          {runApproval && (runApproval.title !== undefined || runApproval.body !== undefined) ? (
            <ProposedPullRequest title={runApproval.title} body={runApproval.body} />
          ) : null}
          {content ? <ProposedContent text={content.text} label={content.label} /> : null}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <a className="dim mr-auto text-xs hover:text-zinc-900 hover:underline dark:hover:text-zinc-100" href={action.href}>
              Inspect target ↗
            </a>
            <button className="btn-ghost h-8 px-3 text-xs" type="button" disabled={busy} onClick={onCancel}>
              Cancel
            </button>
            <button
              className={`${destructive ? 'btn-danger' : 'btn'} h-8 px-3 text-xs`}
              type="button"
              disabled={busy}
              onClick={onExecute}
            >
              {busy ? 'Applying…' : 'Confirm'}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function ProposedPullRequest({
  title,
  body,
}: {
  readonly title?: string;
  readonly body?: string;
}): React.JSX.Element {
  return (
    <details className="mt-2 rounded-md border border-zinc-200 px-2.5 py-2 dark:border-zinc-800">
      <summary className="cursor-pointer text-xs font-medium">Review proposed pull request text</summary>
      <div className="mt-2 space-y-2 text-xs">
        {title !== undefined ? (
          <div>
            <div className="dim mb-0.5 font-medium uppercase">Title</div>
            <pre className="whitespace-pre-wrap break-words font-sans">{title}</pre>
          </div>
        ) : null}
        {body !== undefined ? (
          <div>
            <div className="dim mb-0.5 font-medium uppercase">Body</div>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-sans">{body || '(empty)'}</pre>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function ProposedContent({ text, label }: { readonly text: string; readonly label: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="mt-2 rounded-md border border-zinc-200 px-2.5 py-2 dark:border-zinc-800"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-xs font-medium">{label}</summary>
      {open ? (
        <div className="markdown mt-2 max-h-72 overflow-auto text-xs">
          <Markdown text={text} />
        </div>
      ) : null}
    </details>
  );
}

function sourceLabel(action: PreparedWorkbenchAction): string {
  switch (action.source) {
    case 'assistant':
      return 'AI Help';
    case 'mcp':
      return 'MCP';
    case 'ui':
      return 'Companion';
  }
}

function expiresIn(at: number): string {
  const minutes = Math.max(0, Math.ceil((at - Date.now()) / 60_000));
  if (minutes === 0) return 'expires now';
  if (minutes === 1) return 'expires in 1 minute';
  return `expires in ${minutes} minutes`;
}

function proposedContent(action: PreparedWorkbenchAction): { readonly text: string; readonly label: string } | null {
  if (action.request.action === 'spec.create' || action.request.action === 'doc.create') {
    return { text: action.request.content, label: 'Review proposed content' };
  }
  if (
    action.request.action === 'pr.comment' ||
    action.request.action === 'issue.comment' ||
    action.request.action === 'pr.review-comment.reply' ||
    action.request.action === 'pr.review.submit'
  ) {
    return { text: action.request.body, label: 'Review proposed comment' };
  }
  if (action.request.action === 'pr.review-comment.create') {
    return {
      text: reviewCommentBody(action.request.body, action.request.suggestion),
      label: `Review comment on ${action.request.path}:${action.request.startLine === undefined
        ? action.request.line
        : `${action.request.startLine}-${action.request.line}`}`,
    };
  }
  if (
    (action.request.action === 'issue.close' ||
      action.request.action === 'issue.reopen' ||
      action.request.action === 'pr.close' ||
      action.request.action === 'pr.reopen') &&
    action.request.comment
  ) {
    return { text: action.request.comment, label: 'Review accompanying comment' };
  }
  return null;
}

function reviewCommentBody(body: string, suggestion?: string): string {
  if (suggestion === undefined) return body;
  const longest = Math.max(0, ...[...suggestion.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${body}\n\n${fence}suggestion\n${suggestion}\n${fence}`;
}
