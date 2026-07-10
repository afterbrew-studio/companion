import { useCallback, useState } from 'react';
import { AgentActivity } from '@companion/module-operate/client';
import {
  ActionMenu,
  AiActionMenu,
  CopyText,
  Markdown,
  Page,
  PageLoading,
  Spinner,
  timeAgo,
  useConfirm,
  type MenuAction,
} from '@companion/ui';
import type { PrRecord } from '../../../contract/index.js';
import { codeApi as api } from '../../api.js';
import { CommentsSection } from '../../components/Comments.js';
import { ChecksBadge, GitHubUser, PrStateIcon } from '../../widgets.js';
import { usePr, type UsePr } from './usePr.js';
import { PrChecks } from './PrChecks.js';
import { PrPipelines, RunPipelineModal } from './PrPipelines.js';
import { PrReview, ReviewingStage } from './PrReview.js';
import { PrChanges } from './PrChanges.js';

type Mode = 'detail' | 'review';

/**
 * The one pull-request view. `detail` is the full workspace on the PR — the
 * change, CI, our pipelines, the AI review and the conversation. `review`
 * reuses the same building blocks but leads with the AI review's reasoning and
 * folds the code away. Both are fed entirely by {@link usePr}.
 */
export function PrView({ repo, number, mode = 'detail' }: { repo: string; number: number; mode?: Mode }): JSX.Element {
  const pr = usePr(repo, number);
  const fetchFiles = useCallback(() => api.prFiles(repo, number), [repo, number]);

  if (!pr.pr) return pr.error ? <Page><div className="error-bar">{pr.error}</div></Page> : <PageLoading />;

  const p = pr.pr;
  const review = mode === 'review';

  return (
    <Page className="anim-in">
      <PrHeader pr={p} data={pr} mode={mode} />
      {pr.error ? <div className="error-bar">{pr.error}</div> : null}

      <div className="mt-4 grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_15rem]">
        <div className="flex min-w-0 flex-col gap-4">
          {review ? (
            <ReviewLead pr={pr} canAct={pr.canAct} onRun={() => void pr.analyze()} />
          ) : (
            <>
              <article className="card max-h-[360px] overflow-y-auto">
                {p.body ? <Markdown text={p.body} /> : <span className="dim text-sm">(no description)</span>}
              </article>
              {pr.analyzing && !pr.review ? (
                <div className="banner-info anim-in">
                  <Spinner /> Review agent is reading the diff and CI status…
                </div>
              ) : null}
              {pr.review ? (
                <PrReview
                  review={pr.review}
                  canAct={pr.canAct}
                  busy={pr.busy}
                  onApply={(acct) => void pr.applyReview(acct)}
                  onDismiss={() => void pr.dismissReview()}
                />
              ) : null}
            </>
          )}

          <PrChanges fetchFiles={fetchFiles} />

          <PrChecks
            repo={repo}
            number={number}
            canAct={pr.canAct}
            ciAnalysis={pr.ciAnalysis}
            onFixChecks={pr.canAct && p.state === 'open' ? () => void pr.fixChecks() : null}
          />

          {!review ? <PrPipelines runs={pr.pipelineRuns} /> : null}
          {!review ? <AgentActivity repo={repo} issueNumber={number} /> : null}

          <CommentsSection
            load={() => api.prComments(repo, number)}
            post={pr.canAct ? (body) => api.commentPr(repo, number, body) : undefined}
            canComment={pr.canAct}
          />
        </div>

        <PrSidebar pr={p} />
      </div>
    </Page>
  );
}

/** In review mode the AI verdict is the hero — reviewing / verdict / empty. */
function ReviewLead({ pr, canAct, onRun }: { pr: UsePr; canAct: boolean; onRun: () => void }): JSX.Element {
  if (pr.review) {
    return (
      <PrReview
        review={pr.review}
        canAct={canAct}
        busy={pr.busy}
        emphasis="hero"
        onApply={(acct) => void pr.applyReview(acct)}
        onDismiss={() => void pr.dismissReview()}
      />
    );
  }
  if (pr.analyzing) return <ReviewingStage />;
  return (
    <div className="rounded-2xl border border-zinc-200 p-8 text-center dark:border-zinc-800">
      <h2 className="text-sm font-semibold">No AI review yet</h2>
      <p className="dim mx-auto mt-1 max-w-md text-[13px]">
        Run an AI review — it reads the diff and CI status, then proposes a verdict you can post to GitHub.
      </p>
      {canAct ? (
        <button className="btn mt-4" onClick={onRun}>
          Run AI review
        </button>
      ) : null}
    </div>
  );
}

function PrHeader({ pr, data, mode }: { pr: PrRecord; data: UsePr; mode: Mode }): JSX.Element {
  const { confirmDanger, confirmElement } = useConfirm();
  const [runningPipeline, setRunningPipeline] = useState(false);
  const review = mode === 'review';

  const aiActions: MenuAction[] = [];
  if (data.canAct) {
    aiActions.push({
      label: data.analyzing ? 'Reviewing…' : data.review ? 'Re-run AI review' : 'AI review',
      disabled: data.analyzing,
      onSelect: () => void data.analyze(),
    });
    if (pr.state === 'open' && pr.checks?.state === 'failing') {
      aiActions.push({ label: 'Fix failing checks', disabled: data.agentBusy !== null, onSelect: () => void data.fixChecks() });
    }
    if (pr.state === 'open' && pr.reviewDecision === 'changes_requested') {
      aiActions.push({
        label: 'Address review feedback',
        disabled: data.agentBusy !== null,
        onSelect: () => void data.addressReviews(),
      });
    }
  }
  if (!review && data.canAct && pr.state === 'open' && data.pipelines.length > 0) {
    aiActions.push({ label: 'Run pipeline…', onSelect: () => setRunningPipeline(true) });
  }

  return (
    <header>
      {review ? (
        <nav className="dim mb-1 text-[13px]" aria-label="Breadcrumb">
          <a href="#/prs" className="hover:underline">
            Pull Requests
          </a>{' '}
          / {pr.repo} / #{pr.number}
        </nav>
      ) : null}
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <h1 className="min-w-0 flex-1 text-xl leading-snug font-semibold">
          <CopyText value={`#${pr.number}`} className="dim mr-1.5 align-baseline font-normal">
            #{pr.number}
          </CopyText>
          {pr.title}
        </h1>
        <div className="flex shrink-0 items-center gap-2" role="toolbar" aria-label="Pull request actions">
          {aiActions.length > 0 ? (
            <AiActionMenu label="AI actions" busy={data.analyzing || data.agentBusy !== null} actions={aiActions} />
          ) : null}
          {review ? (
            <a className="btn-ghost" href={`#/repos/${pr.repo}/prs/${pr.number}`}>
              Full PR
            </a>
          ) : null}
          {data.canAct && pr.state === 'open' ? (
            <ActionMenu
              label="More pull request actions"
              actions={[
                {
                  label: 'Squash-merge…',
                  disabled: data.busy,
                  onSelect: () =>
                    void (async () => {
                      const ok = await confirmDanger({
                        title: `Merge PR #${pr.number}`,
                        message: `"${pr.title}" is squash-merged into ${pr.baseRef}. Merging cannot be undone from Companion.`,
                        confirmLabel: 'Squash-merge',
                      });
                      if (ok) await data.merge('squash');
                    })(),
                },
                {
                  label: 'Close PR…',
                  danger: true,
                  disabled: data.busy,
                  onSelect: () =>
                    void (async () => {
                      const ok = await confirmDanger({
                        title: `Close PR #${pr.number}`,
                        message: 'The pull request is closed on GitHub without merging.',
                        confirmLabel: 'Close PR',
                      });
                      if (ok) await data.close();
                    })(),
                },
              ]}
            />
          ) : null}
          <a className="btn-ghost" href={pr.url} target="_blank" rel="noreferrer">
            GitHub ↗
          </a>
        </div>
      </div>
      {confirmElement}
      {runningPipeline ? (
        <RunPipelineModal
          pipelines={data.pipelines}
          onRun={(id) => data.runPipeline(id)}
          onClose={() => setRunningPipeline(false)}
        />
      ) : null}
    </header>
  );
}

/** Right-hand metadata rail: status, branch, people and labels. */
function PrSidebar({ pr }: { pr: PrRecord }): JSX.Element {
  return (
    <aside className="flex flex-col gap-4 text-[13px] lg:sticky lg:top-4" aria-label="Pull request details">
      {/* Short scalar facts read best as an aligned label/value grid. */}
      <div className="card flex flex-col gap-3">
        <Row label="Status">
          <PrStateIcon state={pr.state} draft={pr.draft} decision={pr.reviewDecision} />
        </Row>
        <Row label="Checks">
          {pr.checks ? <ChecksBadge checks={pr.checks} /> : <span className="dim">—</span>}
        </Row>
        {pr.reviewDecision ? (
          <Row label="Review">
            <span className={pr.reviewDecision === 'approved' ? 'badge-ok' : 'badge-warn'}>
              {pr.reviewDecision.replace('_', ' ')}
            </span>
          </Row>
        ) : null}
        {pr.reviewRisk ? (
          <Row label="AI risk">
            <span className={pr.reviewRisk === 'high' ? 'badge-danger' : pr.reviewRisk === 'medium' ? 'badge-warn' : 'badge-ok'}>
              {pr.reviewRisk}
            </span>
          </Row>
        ) : null}
      </div>

      {/* Branch and target on their own lines — each truncates with the full ref on hover. */}
      <div className="card flex flex-col gap-3">
        <Block label="Branch">
          <CopyText value={pr.headRef} title={`Copy "${pr.headRef}"`} className="max-w-full">
            <code className="block min-w-0 truncate font-mono text-xs" title={pr.headRef}>
              {pr.headRef}
            </code>
          </CopyText>
        </Block>
        <Block label="Target">
          <code className="block truncate font-mono text-xs" title={pr.baseRef}>
            {pr.baseRef}
          </code>
        </Block>
      </div>

      <div className="card flex flex-col gap-3">
        <Block label="Author">
          <GitHubUser login={pr.author} className="text-zinc-700 dark:text-zinc-300" />
        </Block>
        {pr.assignees.length > 0 ? (
          <Block label="Assignees">
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {pr.assignees.map((a) => (
                <GitHubUser key={a} login={a} className="text-zinc-700 dark:text-zinc-300" />
              ))}
            </div>
          </Block>
        ) : null}
        {pr.labels.length > 0 ? (
          <Block label="Labels">
            <div className="flex flex-wrap gap-1.5">
              {pr.labels.map((l) => (
                <span key={l} className="chip" title={l}>
                  {l}
                </span>
              ))}
            </div>
          </Block>
        ) : null}
      </div>

      <div className="card flex flex-col gap-2 text-xs">
        <div className="flex justify-between gap-2">
          <span className="dim">Opened</span>
          <span>{timeAgo(pr.createdAt)}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="dim">Updated</span>
          <span>{timeAgo(pr.updatedAt)}</span>
        </div>
        {pr.closedAt ? (
          <div className="flex justify-between gap-2">
            <span className="dim">{pr.state === 'merged' ? 'Merged' : 'Closed'}</span>
            <span>{timeAgo(pr.closedAt)}</span>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

/** Inline label/value row — for short scalar facts. */
function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <span className="dim w-16 shrink-0 pt-0.5 text-xs font-medium tracking-wide uppercase">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

/** Stacked label-above-value block — for wide values (branches, chips, people). */
function Block({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="min-w-0">
      <div className="dim mb-1 text-[11px] font-medium tracking-wide uppercase">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
