import { useState } from 'react';
import { AgentActivity } from '@companion/module-operate/client';
import { ActionMenu, AiActionMenu, Breadcrumb, CopyText, ErrorBar, Markdown, MetaItem, Page, PageLoading, Spinner, Switch, timeAgo, useConfirm, type MenuAction } from '@companion/ui';
import type { TriageResult } from '../../contract/index.js';
import { codeApi as api } from '../api.js';
import { useIssue } from '../hooks/useIssue.js';
import { AccountPicker } from '../components/AccountPicker.js';
import { CommentsSection } from '../components/Comments.js';
import { GitHubUser } from '../widgets.js';

export function IssueDetail({ repo, number }: { repo: string; number: number }): JSX.Element {
  const { issue, triage, error, refresh, canAct, triaging, startTriage, fixing, startFix, busy, setIssueState } =
    useIssue(repo, number);
  const { confirmDanger, confirmElement } = useConfirm();

  const toggleState = async (): Promise<void> => {
    if (!issue) return;
    const next = issue.state === 'open' ? 'closed' : 'open';
    if (
      next === 'closed' &&
      !(await confirmDanger({
        title: `Close issue #${issue.number}`,
        message: 'The issue is closed on GitHub. It can be reopened later.',
        confirmLabel: 'Close issue',
      }))
    )
      return;
    await setIssueState(next);
  };

  if (!issue) return error ? <Page><ErrorBar error={error} /></Page> : <PageLoading />;

  return (
    <Page className="anim-in">
      {/* Header: identity left, action toolbar right. The identity flexes so the
          title wraps first; the toolbar only drops below when space truly runs out. */}
      <header className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <Breadcrumb items={[{ label: 'Issues', href: '#/issues' }, { label: repo }, { label: `#${issue.number}` }]} />
          <h1 className="mt-1 text-xl leading-snug font-semibold">
            <CopyText value={`#${issue.number}`} className="dim mr-1.5 align-baseline font-normal">
              #{issue.number}
            </CopyText>
            {issue.title}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <span className={issue.state === 'open' ? 'badge-ok' : 'badge'}>{issue.state}</span>
            <MetaItem label="by">
              <GitHubUser login={issue.author} />
            </MetaItem>
            <MetaItem label="opened">{timeAgo(issue.createdAt)}</MetaItem>
            <MetaItem label="updated">{timeAgo(issue.updatedAt)}</MetaItem>
            <MetaItem label="comments">{issue.comments}</MetaItem>
            {issue.assignees.length > 0 ? (
              <MetaItem label="assignees">
                {issue.assignees.map((a, i) => (
                  <span key={a}>
                    {i > 0 ? ', ' : ''}
                    <GitHubUser login={a} />
                  </span>
                ))}
              </MetaItem>
            ) : null}
          </div>
          {issue.labels.length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5" aria-label="Labels">
              {issue.labels.map((l) => (
                <span key={l} className="chip">
                  {l}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        {/* Stable order: AI group first, then the overflow menu, then the
            external GitHub link last. */}
        <div className="flex shrink-0 items-center gap-2" role="toolbar" aria-label="Issue actions">
          {canAct ? (
            <AiActionMenu
              label="AI actions"
              busy={triaging || fixing}
              actions={[
                {
                  label: triaging ? 'Triaging…' : triage ? 'Re-triage' : 'AI triage',
                  disabled: triaging,
                  onSelect: () => void startTriage(),
                },
                ...(issue.state === 'open'
                  ? [
                      {
                        label: fixing ? 'Starting fix…' : 'Fix with AI',
                        disabled: fixing,
                        onSelect: () => void startFix(),
                      } as MenuAction,
                    ]
                  : []),
              ]}
            />
          ) : null}
          {canAct ? (
            <ActionMenu
              label="More issue actions"
              actions={[
                issue.state === 'open'
                  ? { label: 'Close issue…', danger: true, disabled: busy, onSelect: () => void toggleState() }
                  : { label: 'Reopen issue', disabled: busy, onSelect: () => void toggleState() },
              ]}
            />
          ) : null}
          <a className="btn-ghost" href={issue.url} target="_blank" rel="noreferrer">
            GitHub ↗
          </a>
        </div>
      </header>
      <ErrorBar error={error} />
      {confirmElement}

      <article className="card mt-4 max-h-[480px] overflow-y-auto">
        {issue.body ? <Markdown text={issue.body} /> : <span className="dim text-sm">(no description)</span>}
      </article>

      <AgentActivity repo={repo} issueNumber={number} />

      {triaging && !triage ? (
        <div className="banner-info anim-in">
          <Spinner /> Triage agent is investigating this issue…
        </div>
      ) : null}
      {triage ? <TriageCard triage={triage} canAct={canAct} onChange={refresh} /> : null}

      <CommentsSection
        load={() => api.issueComments(repo, number)}
        post={canAct ? (body) => api.commentIssue(repo, number, body) : undefined}
        canComment={canAct}
      />
    </Page>
  );
}

function TriageCard({
  triage,
  canAct,
  onChange,
}: {
  triage: TriageResult;
  canAct: boolean;
  onChange: () => Promise<void>;
}): JSX.Element {
  const [comment, setComment] = useState(true);
  const [actAs, setActAs] = useState('');
  const [error, setError] = useState<string | null>(null);
  const v = triage.verdict;
  const sevClass =
    v?.severity === 'critical' || v?.severity === 'high'
      ? 'badge-danger'
      : v?.severity === 'medium'
        ? 'badge-warn'
        : 'badge';

  return (
    <div
      className={`card anim-in mt-4 ${
        triage.status === 'applied' ? 'border-emerald-500/60' : 'border-amber-500/60'
      }`}
    >
      <div className="mb-2 flex items-center gap-2.5">
        <strong>AI triage</strong>
        <span className={triage.status === 'applied' ? 'badge-ok' : 'badge-warn'}>{triage.status}</span>
        <span className="flex-1" />
        <a className="linkish text-xs" href={`#/runs/${triage.runId}`}>
          view run →
        </a>
      </div>
      {v ? (
        <>
          <p className="text-sm">{v.summary}</p>
          <div className="my-2 flex flex-wrap gap-1.5">
            <span className={sevClass}>{v.severity}</span>
            <span className="badge">{v.kind}</span>
            {v.labels.map((l) => (
              <span key={l} className="chip">
                +{l}
              </span>
            ))}
            {v.duplicateOf ? <span className="badge-accent">duplicate of #{v.duplicateOf}</span> : null}
            {v.needsInfo ? <span className="badge-warn">needs info</span> : null}
          </div>
          {v.draftReply ? (
            <blockquote className="my-2.5 border-l-2 border-zinc-300 py-1 pl-3 text-[13px] dark:border-zinc-600">
              <div className="dim">draft reply</div>
              <Markdown text={v.draftReply} />
            </blockquote>
          ) : null}
          {triage.status === 'pending' && canAct ? (
            <div className="mt-3.5 flex flex-wrap items-center gap-2.5 border-t border-zinc-200 pt-3.5 dark:border-zinc-800">
              <label className="dim flex cursor-pointer items-center gap-2 text-[13px]">
                <Switch label="Post the draft reply as a comment" checked={comment} onChange={setComment} />
                post the reply
              </label>
              <span className="flex-1" />
              <AccountPicker value={actAs} onChange={setActAs} />
              <button
                className="btn-ghost"
                onClick={() => void api.dismissTriage(triage.id).then(onChange).catch((e) => setError(String(e)))}
              >
                Dismiss
              </button>
              <button
                className="btn"
                onClick={() =>
                  void api
                    .applyTriage(triage.id, comment, actAs || undefined)
                    .then(onChange)
                    .catch((e) => setError(String(e)))
                }
              >
                Apply to GitHub
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <ErrorBar error={triage.error ?? 'no verdict'} />
      )}
      <ErrorBar error={error} />
    </div>
  );
}
