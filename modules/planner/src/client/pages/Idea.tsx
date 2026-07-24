import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { onServerMessage } from '@companion/core/client';
import { AccentField, ChevronDown, CloseIcon, CopyText, DiffView, EmptyState, ErrorBar, Field, IconButton, LockIcon, Markdown, Modal, Page, PageHeader, PageLoading, QuestionIcon, SmileIcon, SparkleIcon, Spinner, Tooltip, useConfirm } from '@companion/ui';
import { useAuth } from '@companion/module-core/client';
import { BranchPicker } from '@companion/module-code/client';
import type { ProposalAnalysis } from '@companion/module-plan/contract';
import type { RefineItemRecord, RefineItemUpdate } from '@companion/module-refinement/contract';
import type {
  ArtifactBundle,
  FeatureBrief,
  FeaturePlanningSession,
  PlannerDiscussionContext,
  PlannerMessage,
  PlannerQuestion,
  PlannerRevision,
} from '../../contract/index.js';
import { ideasApi } from '../api.js';
import { extractStreamingJsonString } from '../discussion-stream.js';
import { useIdeas } from '../hooks/useIdeas.js';

const STEPS: Array<{ key: FeaturePlanningSession['step']; label: string }> = [
  { key: 'idea', label: 'Idea' },
  { key: 'clarification', label: 'Questions' },
  { key: 'scope_review', label: 'MVP' },
  { key: 'artifacts_review', label: 'Artifacts' },
  { key: 'analysis', label: 'Analysis' },
  { key: 'analysis_review', label: 'Plan review' },
  { key: 'refinement', label: 'Tasks' },
  { key: 'tasks_review', label: 'Task review' },
  { key: 'launched', label: 'Launched' },
];

export default function Idea({ id }: { id: string }): JSX.Element {
  const { can } = useAuth();
  const { confirmDanger, confirmElement } = useConfirm();
  const state = useIdeas(id);
  const [busy, setBusy] = useState(false);
  const [brief, setBrief] = useState<FeatureBrief | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactBundle | null>(null);
  const [artifactTab, setArtifactTab] = useState<keyof ArtifactBundle>('documentation');
  const [preview, setPreview] = useState(true);
  const [answers, setAnswers] = useState<Record<string, { optionId: string | null; value: string }>>({});
  const [discussionOpen, setDiscussionOpen] = useState(false);
  const [discussionContext, setDiscussionContext] = useState<PlannerDiscussionContext>('plan_summary');
  const [discussionDraft, setDiscussionDraft] = useState('');
  const [discussionRequestPending, setDiscussionRequestPending] = useState(false);
  const [mergeIds, setMergeIds] = useState<string[]>([]);
  const session = state.detail?.session ?? null;
  const discussionStreamingText = useDiscussionStream(
    session,
    discussionRequestPending || session?.activeAction === 'discussing',
  );
  const questionSet = session?.questions.map((question) => question.id).join('|') ?? '';
  const artifactsDirty = useMemo(
    () => artifacts !== null && session?.artifacts !== null && JSON.stringify(artifacts) !== JSON.stringify(session?.artifacts),
    [artifacts, session?.artifacts],
  );

  useEffect(() => {
    if (!session) return;
    setBrief(session.brief);
    setArtifacts(session.artifacts);
  }, [session?.revision]);

  useEffect(() => {
    if (!session) return;
    setAnswers((current) => {
      const next: Record<string, { optionId: string | null; value: string }> = {};
      for (const question of session.questions) {
        const recommended = question.options.find((option) => option.recommended);
        next[question.id] = current[question.id] ?? { optionId: recommended?.id ?? null, value: '' };
      }
      return next;
    });
  }, [questionSet]);

  useEffect(() => {
    if (session?.status === 'cancelled') window.location.hash = '/ideas';
  }, [session?.status]);

  const runAction = async (
    fn: () => Promise<unknown>,
    options: { refreshOnError?: boolean } = {},
  ): Promise<string | null> => {
    setBusy(true);
    state.setError(null);
    try {
      await fn();
      await state.refresh();
      return null;
    } catch (err) {
      const message = String(err);
      if (options.refreshOnError !== false) await state.refresh();
      // refresh() clears an existing request error after a successful GET, so
      // publish the mutation error only after the optional recovery refresh.
      state.setError(message);
      return message;
    } finally {
      setBusy(false);
    }
  };
  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    await runAction(fn);
  };
  const cancelSession = async (): Promise<void> => {
    if (!session) return;
    const confirmed = await confirmDanger({
      title: 'Cancel this plan?',
      message: 'The entire planning session will be closed and removed from Ideas. You will not be able to resume it.',
      confirmLabel: 'Cancel plan',
    });
    if (confirmed) await act(() => ideasApi.cancel(id, session.revision));
  };

  if (state.loading) return <PageLoading label="Loading idea…" />;
  if (state.missing || !state.detail || !session) return <EmptyState title="Idea not found" hint="It may have been removed or belong to another workspace." />;

  const canManage = can('planner:manage') && session.status !== 'completed' && session.status !== 'cancelled';
  const planStaysVisible = session.step === 'analysis_review' && session.analysis !== null;
  const interactionDisabled = !canManage || busy || session.status === 'working';
  const canDiscuss = canManage
    && session.step === 'analysis_review'
    && session.status === 'waiting_for_user'
    && session.analysis !== null
    && session.artifacts !== null;
  const openDiscussion = (context: PlannerDiscussionContext = 'plan_summary'): void => {
    setDiscussionContext(context);
    setDiscussionOpen(true);
  };
  const focusPlanReference = (context: PlannerDiscussionContext): void => {
    setDiscussionContext(context);
    if (window.matchMedia('(max-width: 767px)').matches) setDiscussionOpen(false);
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      document.getElementById(`analysis-context-${context}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }));
  };
  const sendDiscussion = async (message: string, context = discussionContext): Promise<void> => {
    const value = message.trim();
    if (!value || !canDiscuss) return;
    setDiscussionRequestPending(true);
    try {
      await act(async () => {
        await ideasApi.discuss(id, session.revision, value, context);
        setDiscussionDraft('');
      });
    } finally {
      setDiscussionRequestPending(false);
    }
  };
  return (
    <div className="flex min-h-full min-w-0">
      <Page className="min-w-0 max-w-6xl flex-1">
      <IdeaHeader session={session} onDiscuss={() => openDiscussion()} />
      <Stepper current={session.step} />
      <ErrorBar error={state.error} className="my-4" />

      {session.status === 'working' ? (
        <Panel>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <div className="flex flex-1 items-start gap-3">
              <span className="mt-1"><Spinner /></span>
              <div>
                <h2 className="font-semibold">{actionLabel(session)}</h2>
                <p className="dim mt-1 text-sm">The agent is reading the repository in read-only mode. You can leave this page; progress is saved.</p>
              </div>
            </div>
            {canManage ? <button className="btn-ghost" disabled={busy} onClick={() => void act(() => ideasApi.stop(id, session.revision))}>Stop</button> : null}
          </div>
        </Panel>
      ) : null}

      {session.status === 'failed' ? (
        <section role="alert" className="mt-5 rounded-xl border border-red-200 bg-red-50/60 p-4 dark:border-red-900/70 dark:bg-red-950/10 sm:p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-red-300 bg-white text-sm font-semibold text-red-700 dark:border-red-800 dark:bg-red-950/50 dark:text-red-300" aria-hidden="true">!</span>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-semibold">{failedStepTitle(session.step)}</h2>
                  <span className="badge-danger">Needs attention</span>
                </div>
                <p className="mt-1 max-w-3xl text-sm leading-6 text-zinc-600 dark:text-zinc-300">{friendlySessionError(session.lastError)}</p>
              </div>
            </div>
            {canManage ? (
              <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
                <button className="btn" disabled={busy} onClick={() => void act(() => session.step === 'tasks_review' ? ideasApi.launch(id, session.revision) : ideasApi.retry(id, session.revision))}>{busy ? <><Spinner /> Retrying…</> : 'Retry step'}</button>
                <button className="btn-ghost" disabled={busy} onClick={() => void cancelSession()}>Cancel</button>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {(session.status !== 'working' && session.status !== 'failed') || planStaysVisible ? (
        <>
          {session.step === 'clarification' ? (
            <Clarification
              questions={session.questions}
              answers={answers}
              setAnswers={setAnswers}
              disabled={!canManage || busy}
              onSubmit={() => act(() => ideasApi.answer(id, session.revision, session.questions.map((question) => ({
                questionId: question.id,
                optionId: answers[question.id]?.optionId,
                value: answers[question.id]?.value,
              }))))}
            />
          ) : null}

          {session.step === 'scope_review' && brief ? (
            <BriefReview
              brief={brief}
              onChange={setBrief}
              disabled={!canManage || busy}
              onConfirm={() => act(() => ideasApi.confirmBrief(id, session.revision, brief))}
            />
          ) : null}

          {session.step === 'artifacts_review' && artifacts ? (
            <ArtifactReview
              artifacts={artifacts}
              dirty={artifactsDirty}
              tab={artifactTab}
              preview={preview}
              disabled={!canManage || busy}
              onTab={setArtifactTab}
              onPreview={setPreview}
              onChange={setArtifacts}
              onSave={() => act(() => ideasApi.saveArtifacts(id, session.revision, artifacts))}
              onCreate={() => act(() => ideasApi.createArtifacts(id, session.revision))}
            />
          ) : null}

          {session.step === 'analysis_review' && session.analysis ? (
            <AnalysisReview
              analysis={session.analysis}
              artifacts={session.artifacts}
              pending={session.pendingRevision}
              focusedContext={discussionContext}
              disabled={interactionDisabled}
              onDiscuss={openDiscussion}
              onApply={() => act(() => ideasApi.applyRevision(id, session.revision))}
              onDiscard={() => act(() => ideasApi.discardRevision(id, session.revision))}
              onApprove={() => act(() => ideasApi.prepareTasks(id, session.revision))}
            />
          ) : null}

          {session.step === 'tasks_review' ? (
            <TaskReview
              session={session}
              items={state.detail.refinementItems}
              board={state.detail.board}
              mergeIds={mergeIds}
              setMergeIds={setMergeIds}
              disabled={!canManage || busy}
              onUpdate={async (itemId, fields) => {
                const error = await runAction(
                  () => ideasApi.updateItem(id, itemId, session.revision, fields),
                  { refreshOnError: false },
                );
                if (error) state.setError(friendlyTaskUpdateError(error));
                return error;
              }}
              onMove={(itemId, direction) => act(() => ideasApi.moveItem(id, itemId, session.revision, direction))}
              onDismiss={(itemId) => act(() => ideasApi.dismissItem(id, itemId, session.revision))}
              onMerge={() => act(async () => {
                await ideasApi.mergeItems(id, session.revision, mergeIds);
                setMergeIds([]);
              })}
              onLaunch={(targetBranch) => act(() => ideasApi.launch(id, session.revision, targetBranch))}
              canExecute={can('planner:execute')}
              canManageBoard={can('board:manage')}
            />
          ) : null}

          {session.step === 'launched' ? <Launched session={session} onReviewHistory={() => openDiscussion()} /> : null}
        </>
      ) : null}

      {canManage && session.status !== 'working' && session.status !== 'failed' ? (
        <div className="mt-8 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <button className="btn-danger-ghost" disabled={busy} onClick={() => void cancelSession()}>Cancel planning session</button>
        </div>
      ) : null}
      </Page>
      {confirmElement}
      <DiscussionPanel
        open={discussionOpen}
        session={session}
        context={discussionContext}
        draft={discussionDraft}
        streamingText={discussionStreamingText}
        setDraft={setDiscussionDraft}
        canSend={canDiscuss}
        busy={busy || discussionRequestPending || session.activeAction === 'discussing' || session.activeAction === 'revising'}
        onContext={setDiscussionContext}
        onReference={focusPlanReference}
        onSend={sendDiscussion}
        onClose={() => setDiscussionOpen(false)}
      />
    </div>
  );
}

function IdeaHeader({ session, onDiscuss }: { session: FeaturePlanningSession; onDiscuss: () => void }): JSX.Element {
  const [showOriginal, setShowOriginal] = useState(false);
  const panelId = `original-idea-${session.id}`;
  return (
    <>
      <PageHeader
        title={displayTitle(session.title)}
        subtitle={(
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>{session.repo} / {session.branch}</span>
            <button
              type="button"
              className="inline-flex cursor-pointer items-center gap-1 border-l border-zinc-300 pl-2 text-xs font-medium text-emerald-700 outline-none transition-colors hover:text-emerald-600 focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-emerald-500 dark:border-zinc-700 dark:text-emerald-400 dark:hover:text-emerald-300"
              aria-expanded={showOriginal}
              aria-controls={panelId}
              onClick={() => setShowOriginal(!showOriginal)}
            >
              {showOriginal ? 'Hide original message' : 'View original message'}
              <ChevronDown open={showOriginal} className="size-3.5" />
            </button>
          </div>
        )}
        actions={(
          <>
            <button type="button" className="btn-ghost gap-1.5" onClick={onDiscuss}>
              <SparkleIcon /> {session.step === 'analysis_review' ? 'Discuss plan' : 'Conversation'}
            </button>
            <a className="btn-ghost" href="#/ideas">All ideas</a>
          </>
        )}
      />
      {showOriginal ? (
        <section id={panelId} className="mb-4 rounded-xl border border-zinc-200 bg-zinc-50/70 p-4 dark:border-zinc-800 dark:bg-zinc-900/70 sm:p-5" aria-label="Original idea message">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Original message</h2>
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">The full message that started this planning session.</p>
            </div>
            <CopyText
              value={session.idea}
              title="Copy original message"
              ariaLabel="Copy original message"
              className="shrink-0 self-start rounded-md px-2 py-1 text-xs font-medium text-zinc-600 outline-none hover:bg-zinc-200/70 focus-visible:ring-2 focus-visible:ring-emerald-500 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Copy message
            </CopyText>
          </div>
          <p className="mt-4 select-text whitespace-pre-wrap break-words text-sm leading-6 text-zinc-700 dark:text-zinc-300">{session.idea}</p>
        </section>
      ) : null}
    </>
  );
}

function Stepper({ current }: { current: FeaturePlanningSession['step'] }): JSX.Element {
  const currentIndex = STEPS.findIndex((step) => step.key === current);
  const currentStep = STEPS[currentIndex] ?? STEPS[0]!;
  const nextStep = STEPS[currentIndex + 1];
  return (
    <nav className="rounded-xl border border-zinc-200 bg-zinc-50/70 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/60" aria-label="Planning progress">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Planning progress</p>
          <p className="mt-0.5 text-sm font-semibold">{currentStep.label}</p>
        </div>
        <p className="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">Step {currentIndex + 1} of {STEPS.length}</p>
      </div>
      <div className="mt-3 grid grid-cols-9 gap-1.5" aria-hidden="true">
        {STEPS.map((step, index) => {
          const active = index === currentIndex;
          const complete = index < currentIndex;
          return (
            <span
              key={step.key}
              className={`h-1.5 rounded-full ${complete ? 'bg-emerald-500' : active ? 'bg-zinc-900 dark:bg-zinc-100' : 'bg-zinc-200 dark:bg-zinc-700'}`}
            />
          );
        })}
      </div>
      <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-zinc-500 dark:text-zinc-400">
        <span>{currentIndex > 0 ? `${currentIndex} completed` : 'Getting started'}</span>
        <span>{nextStep ? `Next: ${nextStep.label}` : 'Planning complete'}</span>
      </div>
      <ol className="sr-only">
        {STEPS.map((step, index) => <li key={step.key} aria-current={index === currentIndex ? 'step' : undefined}>{step.label}</li>)}
      </ol>
    </nav>
  );
}

function Clarification({ questions, answers, setAnswers, disabled, onSubmit }: {
  questions: ReadonlyArray<PlannerQuestion>;
  answers: Record<string, { optionId: string | null; value: string }>;
  setAnswers: (answers: Record<string, { optionId: string | null; value: string }>) => void;
  disabled: boolean;
  onSubmit: () => Promise<void>;
}): JSX.Element {
  const allAnswered = questions.length > 0 && questions.every((question) => {
    const answer = answers[question.id];
    return answer !== undefined && (answer.optionId !== null || answer.value.trim().length > 0);
  });
  return (
    <Panel>
      <h2 className="text-lg font-semibold">A few decisions before we define the MVP</h2>
      <p className="mt-1 max-w-3xl text-sm leading-6 text-zinc-500 dark:text-zinc-400">Choose a recommendation or write your own answer. Technical defaults are handled for you.</p>
      <div className="mt-6 grid gap-7">
        {questions.map((question, questionIndex) => (
          <fieldset key={question.id} className={questionIndex > 0 ? 'border-t border-zinc-200 pt-7 dark:border-zinc-800' : undefined}>
            <legend className="flex max-w-4xl items-start gap-3 font-medium leading-6">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xs font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300" aria-hidden="true">{questionIndex + 1}</span>
              <span>{question.prompt}</span>
            </legend>
            <p className="ml-9 mt-1 max-w-4xl text-xs leading-5 text-zinc-500 dark:text-zinc-400">{question.whyItMatters}</p>
            <div className="mt-4 grid auto-rows-fr gap-3 lg:grid-cols-3">
              {question.options.map((option) => {
                const selected = answers[question.id]?.optionId === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    disabled={disabled}
                    aria-pressed={selected}
                    className={`flex h-full min-h-32 flex-col rounded-xl border p-4 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-zinc-900 ${selected ? 'border-emerald-500 bg-emerald-50/70 dark:bg-emerald-950/25' : 'border-zinc-200 bg-white hover:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-zinc-500'}`}
                    onClick={() => setAnswers({ ...answers, [question.id]: { optionId: option.id, value: answers[question.id]?.value ?? '' } })}
                  >
                    <span className="flex w-full items-start justify-between gap-3">
                      <span className="text-sm font-semibold leading-5">{option.label}</span>
                      <span className={`mt-0.5 size-4 shrink-0 rounded-full border-4 ${selected ? 'border-emerald-600 bg-white dark:bg-zinc-950' : 'border-zinc-300 dark:border-zinc-600'}`} aria-hidden="true" />
                    </span>
                    <span className="mt-2 block text-xs leading-5 text-zinc-500 dark:text-zinc-400">{option.description}</span>
                    {option.recommended ? <span className="badge-ok mt-auto self-start pt-px">Recommended</span> : null}
                  </button>
                );
              })}
            </div>
            <label className={`mt-3 block rounded-xl border p-4 transition-colors ${answers[question.id]?.optionId === null ? 'border-emerald-500 bg-emerald-50/70 dark:bg-emerald-950/25' : 'border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900'}`}>
              <span className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold">Write my own answer</span>
                <span className={`size-4 shrink-0 rounded-full border-4 ${answers[question.id]?.optionId === null ? 'border-emerald-600 bg-white dark:bg-zinc-950' : 'border-zinc-300 dark:border-zinc-600'}`} aria-hidden="true" />
              </span>
              <span className="mt-1 block text-xs leading-5 text-zinc-500 dark:text-zinc-400">Use this when none of the suggested options matches what you need.</span>
              <AccentField className="mt-3">
                <textarea
                  className="input h-auto min-h-20 w-full resize-y leading-5"
                  disabled={disabled}
                  maxLength={4_000}
                  value={answers[question.id]?.value ?? ''}
                  onFocus={() => setAnswers({ ...answers, [question.id]: { optionId: null, value: answers[question.id]?.value ?? '' } })}
                  onChange={(event) => setAnswers({ ...answers, [question.id]: { optionId: null, value: event.target.value } })}
                  placeholder="Describe the outcome you prefer"
                />
              </AccentField>
            </label>
          </fieldset>
        ))}
      </div>
      <div className="mt-7 flex justify-end"><button className="btn whitespace-nowrap" disabled={disabled || !allAnswered} onClick={() => void onSubmit()}>Continue with answers</button></div>
    </Panel>
  );
}

type BriefSectionKey = 'outcome' | 'scope' | 'guardrails';

function BriefReview({ brief, onChange, disabled, onConfirm }: { brief: FeatureBrief; onChange: (brief: FeatureBrief) => void; disabled: boolean; onConfirm: () => Promise<void> }): JSX.Element {
  const [editing, setEditing] = useState<BriefSectionKey | null>(null);
  const [showAllMvp, setShowAllMvp] = useState(false);
  const updateList = (key: BriefListKey, value: string): void => onChange({ ...brief, [key]: lines(value) });
  return (
    <section className="mt-5 overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <header className="border-b border-zinc-200 px-5 py-5 dark:border-zinc-800 sm:px-7 sm:py-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">Review the first release</h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-zinc-500 dark:text-zinc-400">Check the outcome, essential scope and delivery guardrails. Open any section to edit it.</p>
          </div>
          <p className="shrink-0 text-xs font-medium text-emerald-600 dark:text-emerald-400">Editable draft</p>
        </div>
      </header>

      <BriefReviewSection
        title="Outcome"
        description="The problem being solved and the result users should get."
        editing={editing === 'outcome'}
        disabled={disabled}
        onToggle={() => setEditing(editing === 'outcome' ? null : 'outcome')}
        summary={(
          <div className="overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-950/25">
            <div className="grid divide-y divide-zinc-200 dark:divide-zinc-800 md:grid-cols-2 md:divide-x md:divide-y-0">
              <BriefText label="Problem" value={brief.problem} />
              <BriefText label="Goal" value={brief.goal} />
            </div>
          </div>
        )}
      >
        <div className="grid gap-5 md:grid-cols-2">
          <Field label="Problem"><GrowingTextarea disabled={disabled} value={brief.problem} onChange={(value) => onChange({ ...brief, problem: value })} /></Field>
          <Field label="Goal"><GrowingTextarea disabled={disabled} value={brief.goal} onChange={(value) => onChange({ ...brief, goal: value })} /></Field>
        </div>
      </BriefReviewSection>

      <BriefReviewSection
        title="First release"
        description="The smallest useful version and the people it is for."
        editing={editing === 'scope'}
        disabled={disabled}
        onToggle={() => setEditing(editing === 'scope' ? null : 'scope')}
        summary={(
          <div className="space-y-6">
            <BriefAudience items={brief.audience} />
            <div className="border-t border-zinc-200 pt-6 dark:border-zinc-800">
              <BriefRequirements items={brief.mvp} expanded={showAllMvp} onToggle={() => setShowAllMvp(!showAllMvp)} />
            </div>
          </div>
        )}
      >
        <div className="grid gap-5">
          <Field label="Who this is for" hint="One audience per line."><GrowingTextarea disabled={disabled} value={brief.audience.join('\n')} onChange={(value) => updateList('audience', value)} /></Field>
          <Field label="Included in the MVP" hint="One requirement per line."><GrowingTextarea className="min-h-44" disabled={disabled} value={brief.mvp.join('\n')} onChange={(value) => updateList('mvp', value)} /></Field>
        </div>
      </BriefReviewSection>

      <BriefReviewSection
        title="Delivery guardrails"
        description="Boundaries, assumptions and risks the technical plan must respect."
        editing={editing === 'guardrails'}
        disabled={disabled}
        onToggle={() => setEditing(editing === 'guardrails' ? null : 'guardrails')}
        summary={(
          <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
            <BriefDisclosure title="Risks and warnings" description="What could affect delivery or user trust." items={brief.risks} defaultOpen />
            <BriefDisclosure title="Open decisions" description="Choices that still need an explicit answer." items={brief.openDecisions} empty="No open decisions" defaultOpen={brief.openDecisions.length > 0} />
            <BriefDisclosure title="Not in this release" description="Work intentionally excluded from the first version." items={brief.outOfScope} />
            <BriefDisclosure title="Assumptions" description="Conditions the plan currently treats as true." items={brief.assumptions} />
          </div>
        )}
      >
        <div className="grid gap-5">
          <Field label="Not in this release" hint="One boundary per line."><GrowingTextarea disabled={disabled} value={brief.outOfScope.join('\n')} onChange={(value) => updateList('outOfScope', value)} /></Field>
          <Field label="Assumptions" hint="One assumption per line."><GrowingTextarea disabled={disabled} value={brief.assumptions.join('\n')} onChange={(value) => updateList('assumptions', value)} /></Field>
          <Field label="Open decisions" hint="Leave empty when everything is decided."><GrowingTextarea disabled={disabled} value={brief.openDecisions.join('\n')} onChange={(value) => updateList('openDecisions', value)} /></Field>
          <Field label="Risks and warnings" hint="One risk per line."><GrowingTextarea className="min-h-32" disabled={disabled} value={brief.risks.join('\n')} onChange={(value) => updateList('risks', value)} /></Field>
        </div>
      </BriefReviewSection>

      <footer className="flex flex-col gap-4 bg-zinc-50/70 px-5 py-5 dark:bg-zinc-950/25 sm:flex-row sm:items-center sm:justify-between sm:px-7">
        <p className="text-xs leading-5 text-zinc-500 dark:text-zinc-400">{brief.mvp.length} MVP items, {brief.openDecisions.length} open decisions. The next step creates editable planning drafts.</p>
        <button
          type="button"
          className="inline-flex h-10 shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md bg-emerald-600 px-4 text-[13px] font-semibold text-white shadow-sm transition-colors hover:bg-emerald-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45 dark:bg-emerald-500 dark:text-zinc-950 dark:hover:bg-emerald-400 dark:focus-visible:ring-offset-zinc-950"
          disabled={disabled || !brief.problem.trim() || !brief.goal.trim()}
          onClick={() => void onConfirm()}
        >
          <SparkleIcon /> Create planning drafts
        </button>
      </footer>
    </section>
  );
}

function BriefReviewSection({ title, description, editing, disabled, onToggle, summary, children }: {
  title: string;
  description: string;
  editing: boolean;
  disabled: boolean;
  onToggle: () => void;
  summary: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="border-b border-zinc-200 px-5 py-5 last:border-b-0 dark:border-zinc-800 sm:px-7 sm:py-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">{description}</p>
        </div>
        <button
          type="button"
          className="btn-ghost shrink-0 active:translate-y-px"
          disabled={disabled}
          aria-expanded={editing}
          aria-label={`${editing ? 'Finish editing' : 'Edit'} ${title.toLowerCase()}`}
          onClick={onToggle}
        >
          {editing ? 'Done' : 'Edit'}
        </button>
      </div>
      <div className="mt-5">
        {editing ? <div className="rounded-xl bg-zinc-50 p-4 dark:bg-zinc-950/40 sm:p-5">{children}</div> : summary}
      </div>
    </section>
  );
}

function BriefText({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="px-4 py-4 sm:px-5 sm:py-5">
      <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-zinc-800 dark:text-zinc-200">{value || 'Not defined yet'}</p>
    </div>
  );
}

function BriefAudience({ items }: { items: ReadonlyArray<string> }): JSX.Element {
  return (
    <div className="rounded-xl bg-zinc-50 px-4 py-4 dark:bg-zinc-950/40 sm:px-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Who this is for</p>
        <span className="text-[11px] tabular-nums text-zinc-400 dark:text-zinc-500">{items.length}</span>
      </div>
      {items.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {items.map((item, index) => (
            <li key={`${item}-${index}`} className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-2 text-sm leading-6 text-zinc-700 dark:text-zinc-300">
              <span className="text-xs tabular-nums text-zinc-400 dark:text-zinc-500" aria-hidden="true">{index + 1}</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      ) : <p className="mt-2 text-sm text-zinc-400 dark:text-zinc-500">No audience defined yet</p>}
    </div>
  );
}

function BriefRequirements({ items, expanded, onToggle }: {
  items: ReadonlyArray<string>;
  expanded: boolean;
  onToggle: () => void;
}): JSX.Element {
  const visibleItems = expanded ? items : items.slice(0, 6);
  const hiddenCount = items.length - visibleItems.length;
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Included in the MVP</p>
          <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">The capabilities required for the first useful release.</p>
        </div>
        <span className="shrink-0 text-xs tabular-nums text-zinc-400 dark:text-zinc-500">{items.length} items</span>
      </div>
      {items.length > 0 ? (
        <ol id="mvp-requirements" className="mt-5 grid gap-4">
          {visibleItems.map((item, index) => (
            <li key={`${item}-${index}`} className="grid grid-cols-[1.75rem_minmax(0,1fr)] items-start gap-3 text-sm leading-6 text-zinc-800 dark:text-zinc-200">
              <span className="flex size-7 items-center justify-center rounded-md bg-zinc-100 text-xs font-medium tabular-nums text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400" aria-hidden="true">{index + 1}</span>
              <span>{item}</span>
            </li>
          ))}
        </ol>
      ) : <p className="mt-3 text-sm text-zinc-400 dark:text-zinc-500">Nothing included yet</p>}
      {items.length > 6 ? (
        <button
          type="button"
          className="mt-5 inline-flex cursor-pointer items-center gap-2 rounded-md text-xs font-semibold text-emerald-700 outline-none transition-colors hover:text-emerald-600 focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 dark:text-emerald-400 dark:hover:text-emerald-300 dark:focus-visible:ring-offset-zinc-900"
          aria-expanded={expanded}
          aria-controls="mvp-requirements"
          onClick={onToggle}
        >
          {expanded ? 'Show fewer requirements' : `Show ${hiddenCount} more requirements`}
          <ChevronDown open={expanded} />
        </button>
      ) : null}
    </div>
  );
}

function BriefDisclosure({ title, description, items, empty = 'Nothing added yet', defaultOpen = false }: {
  title: string;
  description: string;
  items: ReadonlyArray<string>;
  empty?: string;
  defaultOpen?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details className="border-t border-zinc-200 first:border-t-0 dark:border-zinc-800" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-4 outline-none transition-colors hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500 dark:hover:bg-zinc-950/35 [&::-webkit-details-marker]:hidden">
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{title}</p>
          <p className="mt-0.5 text-xs leading-5 text-zinc-500 dark:text-zinc-400">{description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="text-xs tabular-nums text-zinc-400 dark:text-zinc-500">{items.length}</span>
          <ChevronDown open={open} />
        </div>
      </summary>
      <div className="bg-zinc-50/60 px-4 pb-5 pt-1 dark:bg-zinc-950/25">
        {items.length > 0 ? (
          <ol className="grid gap-3">
            {items.map((item, index) => (
              <li key={`${item}-${index}`} className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-2 text-sm leading-6 text-zinc-700 dark:text-zinc-300">
                <span className="text-xs tabular-nums text-zinc-400 dark:text-zinc-500" aria-hidden="true">{index + 1}</span>
                <span>{item}</span>
              </li>
            ))}
          </ol>
        ) : <p className="text-sm text-zinc-400 dark:text-zinc-500">{empty}</p>}
      </div>
    </details>
  );
}

function ArtifactReview({ artifacts, dirty, tab, preview, disabled, onTab, onPreview, onChange, onSave, onCreate }: {
  artifacts: ArtifactBundle; dirty: boolean; tab: keyof ArtifactBundle; preview: boolean; disabled: boolean;
  onTab: (tab: keyof ArtifactBundle) => void; onPreview: (preview: boolean) => void; onChange: (bundle: ArtifactBundle) => void;
  onSave: () => Promise<void>; onCreate: () => Promise<void>;
}): JSX.Element {
  const labels: Record<keyof ArtifactBundle, string> = { documentation: 'Documentation', specification: 'Specification', implementationPlan: 'Implementation plan' };
  const draft = artifacts[tab];
  return (
    <Panel>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex-1"><div className="flex flex-wrap items-center gap-2"><h2 className="text-lg font-semibold">Review planning artifacts</h2><span className={dirty ? 'badge-warn' : 'badge-ok'}>{dirty ? 'Unsaved edits' : 'Drafts saved'}</span></div><p className="dim mt-1 text-sm">Drafts are private to this session until you create the canonical records.</p></div>
        <button className="btn-ghost" disabled={disabled} onClick={() => onPreview(!preview)}>{preview ? 'Edit markdown' : 'Preview'}</button>
      </div>
      <div className="mt-4 flex flex-wrap gap-2" role="tablist">
        {(Object.keys(labels) as Array<keyof ArtifactBundle>).map((key) => <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'btn' : 'btn-ghost'} onClick={() => onTab(key)}>{labels[key]}</button>)}
      </div>
      <div className="mt-4">
        {preview ? <div className="rounded-xl border border-zinc-200 p-5 dark:border-zinc-800"><h3 className="mb-4 text-xl font-semibold">{draft.title}</h3><Markdown text={draft.content} /></div> : (
          <div className="grid gap-3">
            <Field label="Title"><AccentField><input className="input w-full" disabled={disabled} value={draft.title} onChange={(event) => onChange({ ...artifacts, [tab]: { ...draft, title: event.target.value } })} /></AccentField></Field>
            <Field label="Markdown"><AccentField><textarea className="input min-h-[28rem] w-full font-mono text-xs leading-6" disabled={disabled} value={draft.content} onChange={(event) => onChange({ ...artifacts, [tab]: { ...draft, content: event.target.value } })} /></AccentField></Field>
          </div>
        )}
      </div>
      <div className="mt-6 flex flex-col justify-end gap-2 sm:flex-row"><button className="btn-ghost" disabled={disabled || !dirty} onClick={() => void onSave()}>Save draft edits</button><button className="btn" disabled={disabled || dirty} title={dirty ? 'Save draft edits before creating artifacts' : undefined} onClick={() => void onCreate()}>Create planning artifacts</button></div>
    </Panel>
  );
}

function AnalysisReview({ analysis, artifacts, pending, disabled, focusedContext, onDiscuss, onApply, onDiscard, onApprove }: {
  analysis: ProposalAnalysis; artifacts: ArtifactBundle | null; pending: PlannerRevision | null; disabled: boolean;
  focusedContext: PlannerDiscussionContext;
  onDiscuss: (context?: PlannerDiscussionContext) => void; onApply: () => Promise<void>; onDiscard: () => Promise<void>; onApprove: () => Promise<void>;
}): JSX.Element {
  const [activeChapterTitle, setActiveChapterTitle] = useState('Architecture and integration');
  const chapters: ReadonlyArray<AnalysisChapter> = [
    {
      title: 'Architecture and integration',
      description: 'How the feature fits the current system and its trust boundaries.',
      groups: [
        { label: 'Architecture', values: analysis.architecture, context: 'architecture' },
        { label: 'Data model and migrations', values: analysis.dataModelAndMigrations, context: 'data_model_and_migrations' },
        { label: 'API and UI', values: analysis.apiAndUi, context: 'api_and_ui' },
        { label: 'Authorization, privacy and security', values: analysis.authorizationPrivacySecurity, context: 'authorization_privacy_security' },
      ],
    },
    {
      title: 'Code impact',
      description: 'The areas likely to change, including dependencies and cost considerations.',
      groups: [
        { label: 'Areas and files', values: analysis.touchedAreas, mono: true, context: 'code_areas' },
        { label: 'Dependencies', values: analysis.dependencies, context: 'dependencies' },
        { label: 'Potential costs', values: analysis.costs, context: 'costs' },
      ],
    },
    {
      title: 'Delivery and validation',
      description: 'The implementation sequence and how the result will be verified.',
      groups: [
        { label: 'Implementation steps', values: analysis.steps, context: 'implementation_steps' },
        { label: 'Tests', values: analysis.tests, context: 'tests' },
      ],
    },
    {
      title: 'Release boundary',
      description: 'What belongs in the first release and what is intentionally deferred.',
      groups: [
        { label: 'MVP', values: analysis.mvp, context: 'mvp' },
        { label: 'Later', values: analysis.later, context: 'later' },
      ],
    },
    {
      title: 'Risks and decisions',
      description: 'The items that can materially change scope, safety or delivery.',
      alwaysVisible: true,
      groups: [
        { label: 'Risks', values: analysis.risks, empty: 'No material risks were identified.', context: 'risks' },
        { label: 'Open decisions', values: analysis.openDecisions, empty: 'No open decisions remain.', context: 'open_decisions' },
      ],
    },
  ];
  const focusedChapterTitle = chapters.find((chapter) => chapter.groups.some((group) => group.context === focusedContext))?.title ?? null;
  useEffect(() => {
    if (focusedChapterTitle) setActiveChapterTitle(focusedChapterTitle);
  }, [focusedChapterTitle]);
  const visibleChapters = chapters.filter((chapter) => chapter.alwaysVisible || analysisChapterCount(chapter) > 0);
  const activeChapter = visibleChapters.find((chapter) => chapter.title === activeChapterTitle) ?? visibleChapters[0]!;
  const reviewItems = analysis.risks.length + analysis.openDecisions.length;
  return (
    <section className="mt-5 overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <header className="border-b border-zinc-200 px-5 py-6 dark:border-zinc-800 sm:px-7 sm:py-7">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-3xl">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold tracking-tight">Review the implementation plan</h2>
              <span className={analysis.feasibility === 'high' ? 'badge-ok' : analysis.feasibility === 'low' ? 'badge-danger' : 'badge-warn'}>{analysis.feasibility} feasibility</span>
            </div>
            <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-300">{analysis.summary}</p>
          </div>
          <div className="grid w-full shrink-0 grid-cols-3 rounded-xl border border-zinc-200 bg-zinc-50/70 dark:border-zinc-800 dark:bg-zinc-950/35 lg:w-[22rem]" role="list" aria-label="Implementation plan summary">
            <AnalysisMetric label="Steps" value={analysis.steps.length} description="Implementation steps suggested by the analysis. These are not Board tasks." onDiscuss={() => onDiscuss('implementation_steps')} />
            <AnalysisMetric label="Code areas" value={analysis.touchedAreas.length} description="Files or code areas that the implementation may need to change." onDiscuss={() => onDiscuss('code_areas')} />
            <AnalysisMetric label="Review items" value={reviewItems} description="Risks and open decisions that deserve attention before approval." onDiscuss={() => onDiscuss('review_items')} />
          </div>
        </div>
      </header>

      <section className="border-b border-zinc-200 px-5 py-6 dark:border-zinc-800 sm:px-7">
        <div>
          <h3 className="text-sm font-semibold">Explore the plan</h3>
          <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">Choose one area to review. Only its active subsection is shown below.</p>
        </div>
        <div className="mt-5 overflow-x-auto pb-1">
          <nav className="flex min-w-max gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-950/60" aria-label="Implementation plan areas">
            {visibleChapters.map((chapter) => {
              const selected = chapter.title === activeChapter.title;
              return (
                <button
                  key={chapter.title}
                  type="button"
                  aria-pressed={selected}
                  className={`inline-flex h-10 cursor-pointer items-center gap-2 whitespace-nowrap rounded-md px-3.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-emerald-500 ${selected ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100' : 'text-zinc-500 hover:bg-white/70 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/70 dark:hover:text-zinc-100'}`}
                  onClick={() => setActiveChapterTitle(chapter.title)}
                >
                  {chapter.title}
                  <span className="tabular-nums text-zinc-400 dark:text-zinc-500">{analysisChapterCount(chapter)}</span>
                </button>
              );
            })}
          </nav>
        </div>
        <AnalysisChapterView key={activeChapter.title} chapter={activeChapter} focusedContext={focusedContext} onDiscuss={onDiscuss} />
      </section>

      {pending ? (
        <section className="border-t border-zinc-200 px-5 py-6 dark:border-zinc-800 sm:px-7">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold">Proposed revision</h3><span className="badge-accent">Waiting for approval</span></div>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-600 dark:text-zinc-300">{pending.summary}</p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <button type="button" className="btn-ghost whitespace-nowrap" disabled={disabled} onClick={() => void onDiscard()}>Discard revision</button>
              <button type="button" className="btn whitespace-nowrap" disabled={disabled} onClick={() => void onApply()}>Apply and re-analyze</button>
            </div>
          </div>
          {artifacts ? <DiffView diff={revisionDiff(artifacts, pending.artifacts)} className="mt-5" /> : null}
        </section>
      ) : null}
      <footer className="flex flex-col gap-4 border-t border-zinc-200 bg-zinc-50/70 px-5 py-5 dark:border-zinc-800 dark:bg-zinc-950/35 sm:flex-row sm:items-center sm:justify-between sm:px-7">
        <div className="max-w-xl">
          <button type="button" className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-medium text-emerald-700 outline-none hover:text-emerald-600 focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-emerald-500 dark:text-emerald-400 dark:hover:text-emerald-300" onClick={() => onDiscuss('plan_summary')}>
            <SparkleIcon className="size-3.5" /> Ask a question or request a change
          </button>
          <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">Approval locks this plan and asks the planner to prepare reviewable tasks. It does not start coding yet.</p>
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
          <button
            type="button"
            className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md bg-emerald-600 px-4 text-[13px] font-semibold text-white shadow-sm transition-colors hover:bg-emerald-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-45 dark:bg-emerald-500 dark:text-zinc-950 dark:hover:bg-emerald-400 dark:focus-visible:ring-offset-zinc-950"
            disabled={disabled || pending !== null}
            onClick={() => void onApprove()}
          >
            <SparkleIcon /> Approve and prepare tasks
          </button>
        </div>
      </footer>
    </section>
  );
}

interface AnalysisGroup {
  readonly label: string;
  readonly values: ReadonlyArray<string>;
  readonly context: PlannerDiscussionContext;
  readonly mono?: boolean;
  readonly empty?: string;
}

interface AnalysisChapter {
  readonly title: string;
  readonly description: string;
  readonly groups: ReadonlyArray<AnalysisGroup>;
  readonly alwaysVisible?: boolean;
}

function AnalysisMetric({ label, value, description, onDiscuss }: { label: string; value: number; description: string; onDiscuss: () => void }): JSX.Element {
  return (
    <Tooltip content={description} side="bottom" className="w-full min-w-0 border-r border-zinc-200 last:border-r-0 dark:border-zinc-800">
      <button
        type="button"
        role="listitem"
        aria-label={`${label}: ${value}. ${description} Open this topic in the planning conversation.`}
        className="flex min-h-[4.5rem] w-full cursor-pointer flex-col items-center justify-center px-2 py-3 text-center outline-none transition-colors hover:bg-white/80 focus-visible:bg-white focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500 active:translate-y-px dark:hover:bg-zinc-900/70 dark:focus-visible:bg-zinc-900"
        onClick={onDiscuss}
      >
        <span className="text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-100" aria-hidden="true">{value}</span>
        <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] leading-4 text-zinc-500 dark:text-zinc-400" aria-hidden="true">
          {label}
          <QuestionIcon className="size-3 text-zinc-400 dark:text-zinc-500" />
        </span>
      </button>
    </Tooltip>
  );
}

function AnalysisChapterView({ chapter, focusedContext, onDiscuss }: {
  chapter: AnalysisChapter;
  focusedContext: PlannerDiscussionContext;
  onDiscuss: (context: PlannerDiscussionContext) => void;
}): JSX.Element {
  const groups = chapter.groups.filter((group) => group.values.length > 0 || group.empty !== undefined);
  const [activeGroupLabel, setActiveGroupLabel] = useState(groups[0]!.label);
  const focusedGroupLabel = groups.find((group) => group.context === focusedContext)?.label ?? null;
  useEffect(() => {
    if (focusedGroupLabel) setActiveGroupLabel(focusedGroupLabel);
  }, [focusedGroupLabel]);
  const activeGroup = groups.find((group) => group.label === activeGroupLabel) ?? groups[0]!;
  return (
    <section className="mt-4 overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50/45 dark:border-zinc-800 dark:bg-zinc-950/20">
      <header className="flex flex-col gap-3 border-b border-zinc-200 px-5 py-5 dark:border-zinc-800 sm:flex-row sm:items-start sm:justify-between sm:px-6">
        <div>
          <h4 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{chapter.title}</h4>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-zinc-500 dark:text-zinc-400">{chapter.description}</p>
        </div>
        <button type="button" className="btn-ghost h-8 shrink-0 self-start px-2.5 text-xs" onClick={() => onDiscuss(activeGroup.context)}>
          <SparkleIcon className="size-3.5" /> Ask agent
        </button>
      </header>
      {groups.length > 1 ? (
        <div className="overflow-x-auto border-b border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
          <nav className="flex min-w-max gap-1" aria-label={`${chapter.title} sections`}>
            {groups.map((group) => {
              const selected = group.label === activeGroup.label;
              return (
                <button
                  key={group.label}
                  type="button"
                  aria-pressed={selected}
                  className={`inline-flex h-9 cursor-pointer items-center gap-2 whitespace-nowrap rounded-md px-3 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-emerald-500 ${selected ? 'bg-zinc-100 font-medium text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100' : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'}`}
                  onClick={() => setActiveGroupLabel(group.label)}
                >
                  {group.label}
                  <span className="tabular-nums text-zinc-400 dark:text-zinc-500">{group.values.length}</span>
                </button>
              );
            })}
          </nav>
        </div>
      ) : null}
      <div className="px-5 py-6 sm:px-7 sm:py-7">
        <AnalysisGroupView key={activeGroup.label} group={activeGroup} />
      </div>
    </section>
  );
}

function AnalysisGroupView({ group }: { group: AnalysisGroup }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? group.values : group.values.slice(0, 5);
  const remaining = group.values.length - visible.length;
  return (
    <section id={`analysis-context-${group.context}`} className="mx-auto max-w-3xl scroll-mt-20">
      <div className="flex items-center justify-between gap-3">
        <h5 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{group.label}</h5>
        <span className="text-xs tabular-nums text-zinc-400 dark:text-zinc-500">{group.values.length} {group.values.length === 1 ? 'item' : 'items'}</span>
      </div>
      {visible.length > 0 ? (
        <ol className="mt-4 space-y-3">
          {visible.map((value, index) => (
            <li key={`${value}-${index}`} className="grid grid-cols-[2rem_minmax(0,1fr)] items-start gap-3 rounded-lg bg-white px-3 py-3 dark:bg-zinc-900 sm:px-4">
              <span className="pt-0.5 text-xs font-medium tabular-nums text-zinc-400 dark:text-zinc-500" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
              <span className={`${group.mono ? 'break-all font-mono text-xs' : 'text-sm'} leading-6 text-zinc-700 dark:text-zinc-300`}>{value}</span>
            </li>
          ))}
        </ol>
      ) : <p className="mt-4 rounded-lg bg-white px-4 py-4 text-sm text-emerald-700 dark:bg-zinc-900 dark:text-emerald-400">{group.empty ?? 'Nothing was identified.'}</p>}
      {group.values.length > 5 ? (
        <button
          type="button"
          className="mx-auto mt-5 flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-zinc-600 outline-none transition-colors hover:bg-zinc-100 hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-emerald-500 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Show fewer' : `Show ${remaining} more`}
          <ChevronDown open={expanded} className="size-3.5" />
        </button>
      ) : null}
    </section>
  );
}

function analysisChapterCount(chapter: AnalysisChapter): number {
  return chapter.groups.reduce((total, group) => total + group.values.length, 0);
}

function TaskReviewGuide(): JSX.Element {
  return (
    <section className="mt-5 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900" aria-labelledby="task-review-guide-title">
      <div className="px-4 py-4 sm:px-5">
        <h2 id="task-review-guide-title" className="font-semibold">How task review works</h2>
        <p className="dim mt-1 text-sm">Review the work before agents start. Saving here changes only the plan.</p>
      </div>
      <dl className="grid border-t border-zinc-200 dark:border-zinc-800 sm:grid-cols-2">
        <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800 sm:border-r sm:px-5">
          <dt className="text-sm font-medium">Task content</dt>
          <dd className="dim mt-1 text-xs leading-5">Open a task to check its description and the criteria used to decide when it is complete.</dd>
        </div>
        <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800 sm:px-5">
          <dt className="text-sm font-medium">Priority</dt>
          <dd className="dim mt-1 text-xs leading-5">P0 is most urgent. Priority influences what should be picked first, but it does not block other tasks.</dd>
        </div>
        <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800 sm:border-b-0 sm:border-r sm:px-5">
          <dt className="text-sm font-medium">This task starts after</dt>
          <dd className="dim mt-1 text-xs leading-5">A task waits until every selected prerequisite is complete. Tasks without prerequisites can run in parallel.</dd>
        </div>
        <div className="px-4 py-3 sm:px-5">
          <dt className="text-sm font-medium">Order and combine</dt>
          <dd className="dim mt-1 text-xs leading-5">Arrows organize the review order. Combine joins related tasks. Dismiss removes work that is not needed.</dd>
        </div>
        <div className="border-t border-zinc-200 px-4 py-3 dark:border-zinc-800 sm:col-span-2 sm:px-5">
          <dt className="text-sm font-medium">Target branch</dt>
          <dd className="dim mt-1 text-xs leading-5">The branch that every task pull request will target and eventually merge into. Agents still do their work on separate task branches.</dd>
        </div>
      </dl>
    </section>
  );
}

function TaskReview({ session, items, board, mergeIds, setMergeIds, disabled, onUpdate, onMove, onDismiss, onMerge, onLaunch, canExecute, canManageBoard }: {
  session: FeaturePlanningSession; items: ReadonlyArray<RefineItemRecord>;
  board: NonNullable<ReturnType<typeof useIdeas>['detail']>['board']; mergeIds: string[]; setMergeIds: (ids: string[]) => void; disabled: boolean;
  onUpdate: (itemId: string, fields: RefineItemUpdate) => Promise<string | null>; onMove: (itemId: string, direction: 'up' | 'down') => Promise<void>;
  onDismiss: (itemId: string) => Promise<void>; onMerge: () => Promise<void>; onLaunch: (targetBranch: string) => Promise<void>; canExecute: boolean; canManageBoard: boolean;
}): JSX.Element {
  const proposed = useMemo(() => items.filter((item) => item.status === 'proposed'), [items]);
  const developers = board.workers.filter((worker) => worker.enabled && worker.role === 'developer');
  const [openItemId, setOpenItemId] = useState<string | null>(() => proposed[0]?.id ?? items[0]?.id ?? null);
  const [mergeMode, setMergeMode] = useState(false);
  const [mergeConfirmOpen, setMergeConfirmOpen] = useState(false);
  const [targetBranch, setTargetBranch] = useState(session.targetBranch);
  const mergeAvailable = proposed.length > 1;
  const selectedItems = mergeIds.flatMap((id) => {
    const item = proposed.find((candidate) => candidate.id === id);
    return item ? [item] : [];
  });

  useEffect(() => {
    setTargetBranch(session.targetBranch);
  }, [session.id, session.targetBranch]);

  useEffect(() => {
    if (openItemId !== null && !items.some((item) => item.id === openItemId)) {
      setOpenItemId(proposed[0]?.id ?? items[0]?.id ?? null);
    }
  }, [items, openItemId, proposed]);

  useEffect(() => {
    const proposedIds = new Set(proposed.map((item) => item.id));
    const validMergeIds = mergeIds.filter((id) => proposedIds.has(id));
    if (validMergeIds.length !== mergeIds.length) setMergeIds(validMergeIds);
  }, [mergeIds, proposed, setMergeIds]);

  useEffect(() => {
    if (mergeAvailable) return;
    setMergeMode(false);
    setMergeConfirmOpen(false);
    if (mergeIds.length > 0) setMergeIds([]);
  }, [mergeAvailable, mergeIds.length, setMergeIds]);

  useEffect(() => {
    if (!mergeConfirmOpen || mergeIds.length > 0) return;
    setMergeConfirmOpen(false);
    setMergeMode(false);
  }, [mergeConfirmOpen, mergeIds.length]);

  const stopMerging = (): void => {
    setMergeMode(false);
    setMergeConfirmOpen(false);
    setMergeIds([]);
  };

  return (
    <>
      <TaskReviewGuide />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <Panel>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Review {proposed.length} tasks</h2>
            <p className="dim mt-1 text-sm">Open one task at a time. Adjust its content, dependencies or execution order before launch.</p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <span className="rounded-md bg-zinc-100 px-2.5 py-1.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
              {proposed.length} proposed
            </span>
            {mergeAvailable && !mergeMode ? (
              <button type="button" className="btn-ghost" disabled={disabled} onClick={() => setMergeMode(true)}>
                Combine tasks
              </button>
            ) : null}
          </div>
        </div>

        {mergeMode ? (
          <div className="mt-5 flex flex-col gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                {mergeIds.length === 0 ? 'Select at least two related tasks' : `${mergeIds.length} ${mergeIds.length === 1 ? 'task' : 'tasks'} selected`}
              </p>
              <p className="mt-0.5 text-xs leading-5 text-zinc-600 dark:text-zinc-400">
                Selected tasks will become one. Their content, priority and dependencies will be combined.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button type="button" className="btn-ghost" disabled={disabled} onClick={stopMerging}>Cancel</button>
              <button type="button" className="btn" disabled={disabled || mergeIds.length < 2} onClick={() => setMergeConfirmOpen(true)}>
                Combine {mergeIds.length >= 2 ? `${mergeIds.length} tasks` : 'tasks'}
              </button>
            </div>
          </div>
        ) : null}

        <ol className="mt-5 overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50/40 divide-y divide-zinc-200 dark:border-zinc-800 dark:bg-zinc-950/20 dark:divide-zinc-800">
          {items.length === 0 ? <li className="px-4 py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">No tasks were prepared for this plan.</li> : items.map((item, index) => (
            <TaskEditor
              key={item.id}
              item={item}
              index={index}
              items={items}
              open={openItemId === item.id}
              selected={mergeIds.includes(item.id)}
              mergeMode={mergeMode}
              disabled={disabled}
              onToggle={() => setOpenItemId(openItemId === item.id ? null : item.id)}
              onSelect={(selected) => setMergeIds(selected ? [...mergeIds, item.id] : mergeIds.filter((id) => id !== item.id))}
              onUpdate={onUpdate}
              onMove={onMove}
              onDismiss={onDismiss}
            />
          ))}
        </ol>

        {mergeConfirmOpen ? (
          <Modal title={`Combine ${selectedItems.length} tasks?`} onClose={() => setMergeConfirmOpen(false)}>
            <p className="text-sm leading-6 text-zinc-700 dark:text-zinc-300">
              These tasks will become one task. Their descriptions, acceptance criteria and external dependencies will be combined automatically.
            </p>
            <ol className="mt-4 grid gap-2 rounded-xl bg-zinc-50 p-3 dark:bg-zinc-950/60">
              {selectedItems.map((item) => (
                <li key={item.id} className="flex gap-2 text-sm text-zinc-700 dark:text-zinc-300">
                  <span className="text-zinc-400 dark:text-zinc-500" aria-hidden="true">{selectedItems.indexOf(item) + 1}.</span>
                  <span>{item.title}</span>
                </li>
              ))}
            </ol>
            <p className="mt-3 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
              Other tasks that depend on these items will be updated to depend on the combined task.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="btn-ghost" disabled={disabled} onClick={() => setMergeConfirmOpen(false)}>Cancel</button>
              <button type="button" className="btn" disabled={disabled || selectedItems.length < 2} onClick={() => void onMerge()}>
                Combine tasks
              </button>
            </div>
          </Modal>
        ) : null}
      </Panel>
      <aside className="space-y-4">
        <Panel>
          <h2 className="font-semibold">Launch summary</h2>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm"><dt className="dim">Tasks</dt><dd>{proposed.length}</dd><dt className="dim">Repository</dt><dd className="break-all font-mono text-xs">{session.repo}</dd><dt className="dim">Developers</dt><dd>{developers.length}</dd></dl>
          <div className="mt-4 border-t border-zinc-200 pt-4 dark:border-zinc-800">
            <p className="text-sm font-medium">Target branch</p>
            <p className="dim mt-1 text-xs leading-5">Task pull requests will be opened against this branch.</p>
            <div className="mt-3">
              <BranchPicker
                repo={session.repo}
                workspaceId={session.workspaceId}
                value={targetBranch}
                onChange={setTargetBranch}
                defaultBranch={session.branch}
                disabled={disabled}
                ariaLabel="Task pull request target branch"
              />
            </div>
          </div>
        </Panel>
        <Panel>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h2 className="font-semibold">Board automation</h2>
            {canManageBoard ? <a className="text-xs font-medium text-emerald-600 outline-none hover:text-emerald-500 focus-visible:ring-2 focus-visible:ring-emerald-500 dark:text-emerald-400" href="#/board">Configure</a> : null}
          </div>
          <p className="dim mt-1 text-xs leading-5">
            These settings are inherited from Task Board and cannot be changed from Ideas.
            {canManageBoard ? ' Open Task Board and choose Flow to edit them.' : ' A workspace maintainer can change them in Task Board under Flow.'}
          </p>
          <ul className="mt-3 space-y-2 text-sm"><Setting label="Auto review" enabled={board.config.autoReview} /><Setting label="Auto-fix CI" enabled={board.config.autoFixCi} /><Setting label={`Auto merge (${board.config.mergeMethod})`} enabled={board.config.autoMerge} /></ul>
          {board.config.autoMerge ? <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">Auto-merge is enabled. Approved work with green checks may merge without another manual confirmation.</p> : null}
          {developers.length === 0 ? <p className="mt-3 rounded-lg bg-zinc-100 p-3 text-xs dark:bg-zinc-800">No developer worker is available. Tasks will remain Ready and start automatically when a worker becomes available.</p> : null}
        </Panel>
        <div className="rounded-xl border-2 border-zinc-900 p-4 dark:border-zinc-100"><p className="text-sm font-semibold">This starts real agent work</p><p className="dim mt-1 text-xs">Tasks are created with queue enabled and their pull requests target <span className="font-mono text-zinc-700 dark:text-zinc-200">{targetBranch || 'the selected branch'}</span>.</p><button className="btn mt-4 w-full justify-center" disabled={disabled || !canExecute || proposed.length === 0 || !targetBranch.trim()} onClick={() => void onLaunch(targetBranch)}>Create tasks & start work</button></div>
      </aside>
      </div>
    </>
  );
}

const TASK_PRIORITY_META: Record<RefineItemRecord['priority'], { label: string; className: string }> = {
  0: { label: 'P0 urgent', className: 'text-red-600 dark:text-red-400' },
  1: { label: 'P1 high', className: 'text-amber-600 dark:text-amber-400' },
  2: { label: 'P2 normal', className: 'text-zinc-600 dark:text-zinc-300' },
  3: { label: 'P3 someday', className: 'text-zinc-400 dark:text-zinc-500' },
};

function dependencyWouldCreateCycle(itemId: string, candidateId: string, items: ReadonlyArray<RefineItemRecord>): boolean {
  const byOrd = new Map(items.map((item) => [item.ord, item]));
  const candidate = items.find((item) => item.id === candidateId);
  const visited = new Set<string>();
  const reachesEditedItem = (current: RefineItemRecord): boolean => {
    if (current.id === itemId) return true;
    if (visited.has(current.id)) return false;
    visited.add(current.id);
    return current.dependsOn.some((ord) => {
      const dependency = byOrd.get(ord);
      return dependency ? reachesEditedItem(dependency) : false;
    });
  };
  return candidate ? reachesEditedItem(candidate) : false;
}

function TaskEditor({ item, index, items, open, selected, mergeMode, disabled, onToggle, onSelect, onUpdate, onMove, onDismiss }: {
  item: RefineItemRecord; index: number; items: ReadonlyArray<RefineItemRecord>; open: boolean; selected: boolean; mergeMode: boolean; disabled: boolean;
  onToggle: () => void;
  onSelect: (selected: boolean) => void; onUpdate: (itemId: string, fields: RefineItemUpdate) => Promise<string | null>;
  onMove: (itemId: string, direction: 'up' | 'down') => Promise<void>; onDismiss: (itemId: string) => Promise<void>;
}): JSX.Element {
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description);
  const [acceptance, setAcceptance] = useState(item.acceptance);
  const [priority, setPriority] = useState(item.priority);
  const [editing, setEditing] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showFullDescription, setShowFullDescription] = useState(false);
  const [showAllCriteria, setShowAllCriteria] = useState(false);
  const byOrd = useMemo(() => new Map(items.map((entry) => [entry.ord, entry.id])), [items]);
  const blockedDependencyIds = useMemo(() => new Set(
    items
      .filter((candidate) => candidate.id !== item.id && dependencyWouldCreateCycle(item.id, candidate.id, items))
      .map((candidate) => candidate.id),
  ), [item.id, items]);
  const [dependsOnIds, setDependsOnIds] = useState<string[]>(item.dependsOn.flatMap((ord) => byOrd.get(ord) ? [byOrd.get(ord)!] : []));
  const acceptanceItems = taskLines(acceptance);
  const visibleCriteria = showAllCriteria ? acceptanceItems : acceptanceItems.slice(0, 4);
  const dependencyItems = dependsOnIds.flatMap((id) => {
    const dependencyIndex = items.findIndex((candidate) => candidate.id === id);
    const dependency = items[dependencyIndex];
    return dependency ? [{ item: dependency, index: dependencyIndex }] : [];
  });
  const draftDependencySummary = dependencyItems.length === 0
    ? `Task ${index + 1} can start independently.`
    : `Task ${index + 1} will wait for ${dependencyItems.map((dependency) => `task ${dependency.index + 1}`).join(' and ')} to finish.`;
  const persistedDependencyItems = item.dependsOn.flatMap((ord) => {
    const dependencyIndex = items.findIndex((candidate) => candidate.ord === ord);
    const dependency = items[dependencyIndex];
    return dependency ? [{ item: dependency, index: dependencyIndex }] : [];
  });
  const dependencySummary = persistedDependencyItems.length === 0
    ? `Task ${index + 1} has no prerequisites and can start independently.`
    : `Task ${index + 1} waits for ${persistedDependencyItems.map((dependency) => `task ${dependency.index + 1}`).join(' and ')} to finish.`;
  const resetDraft = (): void => {
    setTitle(item.title);
    setDescription(item.description);
    setAcceptance(item.acceptance);
    setPriority(item.priority);
    setDependsOnIds(item.dependsOn.flatMap((ord) => byOrd.get(ord) ? [byOrd.get(ord)!] : []));
    setSaveError(null);
  };

  useEffect(() => {
    resetDraft();
  }, [item, byOrd]);

  useEffect(() => {
    if (!open) {
      setEditing(false);
      setShowFullDescription(false);
      setShowAllCriteria(false);
    }
  }, [open]);

  const editable = item.status === 'proposed' && !disabled;
  const saveChanges = async (): Promise<void> => {
    setSaveError(null);
    const error = await onUpdate(item.id, { title, description, acceptance, priority, dependsOnIds });
    if (error) {
      setSaveError(friendlyTaskUpdateError(error));
      return;
    }
    setEditing(false);
  };
  return (
    <li className={`${selected ? 'bg-emerald-500/5' : open ? 'bg-white dark:bg-zinc-900' : 'transition-colors hover:bg-white/70 dark:hover:bg-zinc-900/60'} ${item.status === 'dismissed' ? 'opacity-60' : ''}`}>
      <div className="grid grid-cols-[2rem_minmax(0,1fr)] items-center gap-2 px-3 py-3 sm:flex sm:px-4">
        <span className={`flex size-8 shrink-0 items-center justify-center rounded-md text-xs font-medium tabular-nums ${open ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'}`} aria-hidden="true">
          {String(index + 1).padStart(2, '0')}
        </span>

        <button type="button" className="min-w-0 flex-1 cursor-pointer rounded-md px-1.5 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-expanded={open} aria-label={`${item.title}. ${dependencySummary}`} onClick={onToggle}>
          <span className="block truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{item.title}</span>
          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
            <span className={`font-medium ${TASK_PRIORITY_META[item.priority].className}`}>{TASK_PRIORITY_META[item.priority].label}</span>
            <span>{acceptanceItems.length} {acceptanceItems.length === 1 ? 'criterion' : 'criteria'}</span>
            {persistedDependencyItems.length === 0 ? <span>No dependencies</span> : (
              <Tooltip
                side="bottom"
                content={(
                  <span className="block">
                    <span className="block font-medium text-zinc-900 dark:text-zinc-100">Task {index + 1} waits until:</span>
                    {persistedDependencyItems.map((dependency) => (
                      <span key={dependency.item.id} className="mt-1 block">Task {dependency.index + 1}: {dependency.item.title}</span>
                    ))}
                  </span>
                )}
              >
                <span className="cursor-help underline decoration-dotted underline-offset-2">{persistedDependencyItems.length} {persistedDependencyItems.length === 1 ? 'dependency' : 'dependencies'}</span>
              </Tooltip>
            )}
            {item.status !== 'proposed' ? <span className="capitalize">{item.status}</span> : null}
          </span>
        </button>

        <div className="col-start-2 flex shrink-0 items-center justify-end gap-1 sm:col-auto sm:ml-auto">
          {mergeMode && item.status === 'proposed' ? (
            <label className={`flex h-8 shrink-0 items-center gap-2 rounded-md border px-2.5 text-xs font-medium transition-colors ${selected ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-zinc-200 bg-white text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300'} ${editable ? 'cursor-pointer hover:border-emerald-500/50' : 'cursor-default'}`}>
              <input
                type="checkbox"
                className="size-3.5 cursor-pointer accent-emerald-600 disabled:cursor-default"
                checked={selected}
                disabled={!editable}
                onChange={(event) => onSelect(event.target.checked)}
              />
              Select
            </label>
          ) : null}
          <Tooltip content="Move earlier">
            <button type="button" className="flex size-8 cursor-pointer items-center justify-center rounded-md text-zinc-400 outline-none transition-colors hover:bg-zinc-100 hover:text-zinc-800 focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-default disabled:opacity-30 dark:hover:bg-zinc-800 dark:hover:text-zinc-100" disabled={!editable || index === 0} aria-label="Move task earlier" onClick={() => void onMove(item.id, 'up')}>↑</button>
          </Tooltip>
          <Tooltip content="Move later">
            <button type="button" className="flex size-8 cursor-pointer items-center justify-center rounded-md text-zinc-400 outline-none transition-colors hover:bg-zinc-100 hover:text-zinc-800 focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-default disabled:opacity-30 dark:hover:bg-zinc-800 dark:hover:text-zinc-100" disabled={!editable || index === items.length - 1} aria-label="Move task later" onClick={() => void onMove(item.id, 'down')}>↓</button>
          </Tooltip>
          <button type="button" className="flex size-8 cursor-pointer items-center justify-center rounded-md outline-none transition-colors hover:bg-zinc-100 focus-visible:ring-2 focus-visible:ring-emerald-500 dark:hover:bg-zinc-800" aria-label={open ? 'Collapse task' : 'Open task'} aria-expanded={open} onClick={onToggle}>
            <ChevronDown open={open} />
          </button>
        </div>
      </div>

      {open ? (
        <div className="border-t border-zinc-200 px-4 py-5 dark:border-zinc-800 sm:px-5">
          {editing ? (
            <div className="grid gap-4">
              <Field label="Title"><AccentField><input className="input w-full" disabled={!editable} value={title} onChange={(event) => setTitle(event.target.value)} /></AccentField></Field>
              <Field label="Description"><AccentField><textarea className="input min-h-28 w-full resize-y leading-5" disabled={!editable} value={description} onChange={(event) => setDescription(event.target.value)} /></AccentField></Field>
              <Field label="Acceptance criteria"><AccentField><textarea className="input min-h-32 w-full resize-y leading-5" disabled={!editable} value={acceptance} onChange={(event) => setAcceptance(event.target.value)} /></AccentField></Field>
              <div className="grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
                <Field label="Priority">
                  <select className="input w-full" disabled={!editable} value={priority} onChange={(event) => setPriority(Number(event.target.value) as 0 | 1 | 2 | 3)}>
                    <option value={0}>P0 - urgent</option>
                    <option value={1}>P1 - high</option>
                    <option value={2}>P2 - normal</option>
                    <option value={3}>P3 - someday</option>
                  </select>
                </Field>
                <Field label="This task starts after" hint="Choose only tasks that must finish before this one can start.">
                  <div className="grid gap-1.5">
                    <p className="mb-1 rounded-lg bg-zinc-50 px-3 py-2 text-xs font-medium leading-5 text-zinc-700 dark:bg-zinc-950/50 dark:text-zinc-300">
                      {draftDependencySummary}
                    </p>
                    {items.filter((candidate) => candidate.id !== item.id && candidate.status !== 'dismissed').map((candidate) => {
                      const candidateIndex = items.findIndex((entry) => entry.id === candidate.id);
                      const active = dependsOnIds.includes(candidate.id);
                      const cycleBlocked = !active && blockedDependencyIds.has(candidate.id);
                      return (
                        <button
                          key={candidate.id}
                          type="button"
                          className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-left text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-emerald-500 ${cycleBlocked ? 'cursor-not-allowed border-zinc-200 bg-zinc-50/70 text-zinc-400 dark:border-zinc-800 dark:bg-zinc-950/30 dark:text-zinc-600' : active ? 'cursor-pointer border-emerald-500/50 bg-emerald-500/5 text-zinc-900 dark:text-zinc-100' : 'cursor-pointer border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800'}`}
                          aria-pressed={active}
                          disabled={!editable || cycleBlocked}
                          onClick={() => {
                            setSaveError(null);
                            setDependsOnIds(active ? dependsOnIds.filter((id) => id !== candidate.id) : [...dependsOnIds, candidate.id]);
                          }}
                        >
                          <span className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border text-[10px] ${active ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-zinc-300 text-transparent dark:border-zinc-600'}`}>✓</span>
                          <span className="min-w-0">
                            <span className="block truncate">{candidateIndex + 1}. {candidate.title}</span>
                            {cycleBlocked ? <span className="mt-0.5 block text-[11px] leading-4 text-amber-700 dark:text-amber-400">Task {candidateIndex + 1} already starts after this task. Selecting it would create a circular wait.</span> : null}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </Field>
              </div>
              {saveError ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-800 dark:border-red-900/70 dark:bg-red-950/20 dark:text-red-300">{saveError}</p> : null}
              <div className="flex flex-wrap justify-between gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800">
                <button className="btn-danger-ghost" disabled={!editable} onClick={() => void onDismiss(item.id)}>Dismiss task</button>
                <div className="flex gap-2">
                  <button className="btn-ghost" type="button" onClick={() => { resetDraft(); setEditing(false); }}>Cancel</button>
                  <button className="btn" disabled={!editable || !title.trim()} onClick={() => void saveChanges()}>Save changes</button>
                </div>
              </div>
            </div>
          ) : (
            <div>
              <dl className="mb-5 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg bg-zinc-50 px-3 py-2.5 text-xs dark:bg-zinc-950/50">
                <div className="flex items-center gap-2">
                  <dt className="text-zinc-500 dark:text-zinc-400">Priority</dt>
                  <dd className={`font-medium ${TASK_PRIORITY_META[item.priority].className}`}>{TASK_PRIORITY_META[item.priority].label}</dd>
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <dt className="text-zinc-500 dark:text-zinc-400">This task starts after</dt>
                  <dd className="flex min-w-0 flex-wrap gap-1.5">
                    {dependencyItems.length > 0 ? dependencyItems.map((dependency) => (
                      <span key={dependency.item.id} className="max-w-full truncate rounded-md border border-zinc-200 bg-white px-2 py-1 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                        {dependency.index + 1}. {dependency.item.title}
                      </span>
                    )) : <span className="text-zinc-500 dark:text-zinc-400">No dependencies</span>}
                  </dd>
                </div>
              </dl>

              <div className="min-w-0">
                <h3 className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Description</h3>
                <p className={`mt-2 text-sm leading-6 whitespace-pre-wrap text-zinc-700 dark:text-zinc-300 ${showFullDescription ? '' : 'line-clamp-4'}`}>{description || 'No description provided.'}</p>
                {description.length > 280 ? <button type="button" className="mt-2 cursor-pointer text-xs font-medium text-emerald-600 hover:text-emerald-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 dark:text-emerald-400" onClick={() => setShowFullDescription(!showFullDescription)}>{showFullDescription ? 'Show less' : 'Read full description'}</button> : null}

                <h3 className="mt-5 text-xs font-medium text-zinc-500 dark:text-zinc-400">Acceptance criteria</h3>
                {visibleCriteria.length > 0 ? (
                  <ol className="mt-2 grid gap-2">
                    {visibleCriteria.map((criterion, criterionIndex) => (
                      <li key={`${criterion}-${criterionIndex}`} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2 text-sm leading-6 text-zinc-700 dark:text-zinc-300">
                        <span className="pt-0.5 text-xs tabular-nums text-zinc-400 dark:text-zinc-500">{String(criterionIndex + 1).padStart(2, '0')}</span>
                        <span>{criterion}</span>
                      </li>
                    ))}
                  </ol>
                ) : <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">No acceptance criteria provided.</p>}
                {acceptanceItems.length > 4 ? <button type="button" className="mt-3 cursor-pointer text-xs font-medium text-emerald-600 hover:text-emerald-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 dark:text-emerald-400" onClick={() => setShowAllCriteria(!showAllCriteria)}>{showAllCriteria ? 'Show fewer criteria' : `Show ${acceptanceItems.length - 4} more`}</button> : null}
              </div>

              <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800">
                {item.status === 'proposed' ? (
                  <>
                    <button className="btn-danger-ghost" disabled={!editable} onClick={() => void onDismiss(item.id)}>Dismiss task</button>
                    <button className="btn-ghost" disabled={!editable} onClick={() => setEditing(true)}>Edit task</button>
                  </>
                ) : item.taskId ? <a className="btn-ghost" href={`#/board?task=${encodeURIComponent(item.taskId)}`}>Open task {item.taskId}</a> : <span className="dim">This task is locked.</span>}
              </div>
            </div>
          )}
        </div>
      ) : null}
    </li>
  );
}

function taskLines(value: string): string[] {
  return lines(value).map((line) => line.replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, ''));
}

function Launched({ session, onReviewHistory }: { session: FeaturePlanningSession; onReviewHistory: () => void }): JSX.Element {
  const taskLabel = `${session.taskIds.length} ${session.taskIds.length === 1 ? 'task' : 'tasks'}`;
  return (
    <>
      <section className="relative mt-5 overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900" aria-labelledby="launched-title">
        <div className="pointer-events-none absolute left-1/2 top-14 size-56 -translate-x-1/2 rounded-full bg-emerald-500/10 blur-3xl dark:bg-emerald-400/10" aria-hidden="true" />
        <div className="relative mx-auto flex max-w-3xl flex-col items-center px-5 py-10 text-center sm:px-8 sm:py-12 lg:py-14">
          <div className="flex size-20 items-center justify-center rounded-full border border-emerald-500/60 bg-emerald-500/5 text-emerald-600 shadow-[inset_0_1px_0_rgb(255_255_255/0.7)] dark:bg-emerald-500/10 dark:text-emerald-400 dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.08)]" aria-hidden="true">
            <SmileIcon className="size-12" />
          </div>
          <h2 id="launched-title" className="mt-6 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">Your tasks are on the Board</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-600 dark:text-zinc-300">Planning is complete. Your tasks are ready and the Board will coordinate the work from here.</p>

          <dl className="mt-8 grid w-full overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50/70 text-left divide-y divide-zinc-200 dark:border-zinc-800 dark:bg-zinc-950/30 dark:divide-zinc-800 sm:grid-cols-[0.75fr_1.5fr_0.75fr] sm:divide-x sm:divide-y-0">
            <div className="min-w-0 px-5 py-4 text-center">
              <dt className="text-xs text-zinc-500 dark:text-zinc-400">Created</dt>
              <dd className="mt-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">{taskLabel}</dd>
            </div>
            <div className="min-w-0 px-5 py-4 text-center">
              <dt className="text-xs text-zinc-500 dark:text-zinc-400">Repository</dt>
              <dd className="mt-1 truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100" title={session.repo}>{session.repo}</dd>
            </div>
            <div className="min-w-0 px-5 py-4 text-center">
              <dt className="text-xs text-zinc-500 dark:text-zinc-400">Branch</dt>
              <dd className="mt-1 truncate font-mono text-sm font-medium text-zinc-900 dark:text-zinc-100" title={session.branch}>{session.branch}</dd>
            </div>
          </dl>

          <p className="mt-6 flex max-w-xl items-start justify-center gap-2 text-left text-sm leading-5 text-zinc-600 dark:text-zinc-300 sm:items-center sm:text-center">
            <span className="mt-1 size-2 shrink-0 rounded-full bg-emerald-500 sm:mt-0" aria-hidden="true" />
            Agents will start automatically when a developer becomes available.
          </p>
          <div className="mt-7 flex w-full flex-col justify-center gap-2.5 sm:w-auto sm:flex-row">
            <a
              className="inline-flex h-10 cursor-pointer items-center justify-center whitespace-nowrap rounded-md bg-emerald-600 px-5 text-[13px] font-semibold text-white shadow-sm transition-colors hover:bg-emerald-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 active:translate-y-px dark:bg-emerald-500 dark:text-zinc-950 dark:hover:bg-emerald-400 dark:focus-visible:ring-offset-zinc-900"
              href="#/board"
            >
              Open Task Board
            </a>
            <button type="button" className="btn-ghost h-10 justify-center whitespace-nowrap px-5 active:translate-y-px" onClick={onReviewHistory}>Review planning history</button>
          </div>
        </div>
      </section>

      <aside className="mx-auto mt-4 flex max-w-3xl items-start gap-3 rounded-xl border border-zinc-200 bg-zinc-50/70 px-4 py-3 text-sm leading-5 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-300">
        <LockIcon className="mt-0.5 size-4 shrink-0 text-zinc-500 dark:text-zinc-400" />
        <p>This idea is now read-only. Further changes happen on the Board.</p>
      </aside>
    </>
  );
}

const MAX_DISCUSSION_STREAM_BUFFER = 64_000;
const MAX_BUFFERED_RUNS = 8;

/**
 * Discussion runs use the platform's normal run event stream. Before the
 * session refresh reveals the exact run id, keep a tiny bounded buffer of
 * visible chunks; once the id arrives, only that run is rendered. This avoids
 * a second streaming transport and prevents raw strict-JSON output from ever
 * reaching the chat UI.
 */
function useDiscussionStream(session: FeaturePlanningSession | null, armed: boolean): string {
  const [text, setText] = useState('');
  const buffersRef = useRef(new Map<string, string>());
  const activeRunRef = useRef<string | null>(null);
  const armedRef = useRef(armed);

  useEffect(() => {
    buffersRef.current.clear();
    activeRunRef.current = null;
    setText('');
  }, [session?.id]);

  useEffect(() => {
    armedRef.current = armed;
    const activeRunId = session?.activeAction === 'discussing' ? session.activeRunId : null;
    if (!armed) {
      buffersRef.current.clear();
      activeRunRef.current = null;
      setText('');
      return;
    }
    if (!activeRunId || activeRunId === activeRunRef.current) return;
    activeRunRef.current = activeRunId;
    const buffered = buffersRef.current.get(activeRunId) ?? '';
    buffersRef.current = new Map(buffered ? [[activeRunId, buffered]] : []);
    setText(extractStreamingJsonString(buffered, 'answer'));
  }, [armed, session?.activeAction, session?.activeRunId]);

  useEffect(() => onServerMessage((message) => {
    if (!armedRef.current || message.t !== 'event') return;
    const activeRunId = activeRunRef.current;
    if (activeRunId && message.runId !== activeRunId) return;
    const event = message.event;
    if (event.type !== 'assistant_chunk' && event.type !== 'assistant_message') return;

    const buffers = buffersRef.current;
    if (!buffers.has(message.runId) && buffers.size >= MAX_BUFFERED_RUNS) {
      const oldest = buffers.keys().next().value as string | undefined;
      if (oldest) buffers.delete(oldest);
    }
    const current = buffers.get(message.runId) ?? '';
    const next = event.type === 'assistant_chunk'
      ? `${current}${(event as { readonly delta?: string }).delta ?? ''}`
      : (event as { readonly content?: string }).content ?? current;
    const bounded = next.slice(-MAX_DISCUSSION_STREAM_BUFFER);
    buffers.set(message.runId, bounded);
    if (message.runId === activeRunRef.current) {
      setText(extractStreamingJsonString(bounded, 'answer'));
    }
  }), []);

  return text;
}

function DiscussionPanel({ open, session, context, draft, streamingText, setDraft, canSend, busy, onContext, onReference, onSend, onClose }: {
  open: boolean;
  session: FeaturePlanningSession;
  context: PlannerDiscussionContext;
  draft: string;
  streamingText: string;
  setDraft: (value: string) => void;
  canSend: boolean;
  busy: boolean;
  onContext: (context: PlannerDiscussionContext) => void;
  onReference: (context: PlannerDiscussionContext) => void;
  onSend: (message: string, context?: PlannerDiscussionContext) => Promise<void>;
  onClose: () => void;
}): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const followLatest = useRef(true);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && followLatest.current) list.scrollTop = list.scrollHeight;
  }, [session.messages.length, streamingText, busy]);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    const frame = window.requestAnimationFrame(() => composerRef.current?.focus());
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);
  const contextName = discussionContextLabel(context);
  const available = session.step === 'analysis_review' && session.analysis !== null && session.artifacts !== null;
  return (
    <aside
      className={`flex shrink-0 flex-col bg-white transition-[width,transform,visibility] duration-200 ease-in-out motion-reduce:transition-none max-md:fixed max-md:inset-y-0 max-md:right-0 max-md:z-50 max-md:h-dvh max-md:w-full max-md:shadow-2xl md:sticky md:top-0 md:h-[calc(100dvh-2.75rem)] md:self-start md:overflow-hidden dark:bg-zinc-950 ${
        open
          ? 'border-l border-zinc-200 max-md:translate-x-0 md:w-[26rem] dark:border-zinc-800'
          : 'invisible max-md:translate-x-full md:w-0'
      }`}
      role="complementary"
      aria-label="Planning conversation"
      aria-hidden={!open}
    >
      <div className="flex h-full w-full min-w-0 flex-col md:w-[26rem]">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-zinc-200 px-3.5 dark:border-zinc-800">
          <span className="flex size-6 items-center justify-center rounded-md bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" aria-hidden="true">
            <SparkleIcon className="size-3.5" />
          </span>
          <div className="min-w-0 flex-1 text-[13px] font-semibold">Planning conversation</div>
          <IconButton label="Close planning conversation" onClick={onClose}>
            <CloseIcon className="size-3.5" />
          </IconButton>
        </div>
        <header className="shrink-0 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-2 text-xs">
              <span className="shrink-0 text-zinc-500 dark:text-zinc-400">Focus</span>
              <strong className="truncate font-medium text-zinc-800 dark:text-zinc-100">{contextName}</strong>
              {context !== 'plan_summary' ? <button type="button" className="shrink-0 cursor-pointer text-emerald-700 outline-none hover:text-emerald-600 focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-emerald-500 dark:text-emerald-400" onClick={() => onContext('plan_summary')}>Use whole plan</button> : null}
            </div>
            <span className="badge-accent shrink-0">Review before apply</span>
          </div>
        </header>

        <div
          ref={listRef}
          className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5"
          aria-live="polite"
          onScroll={(event) => {
            const element = event.currentTarget;
            followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
          }}
        >
          {session.messages.map((message) => (
            <DiscussionMessage
              key={message.id}
              message={message}
              canRespond={canSend && !busy}
              onChoose={(value) => void onSend(value, message.context ?? context)}
              onCustom={() => composerRef.current?.focus()}
              onReference={onReference}
            />
          ))}
          {streamingText.trim() ? (
            <StreamingDiscussionMessage text={streamingText} />
          ) : busy ? (
            <div className="mr-auto flex max-w-[92%] items-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
              <Spinner /> {session.activeAction === 'revising' ? 'Preparing a reviewable revision…' : 'Reviewing the plan and your question…'}
            </div>
          ) : null}
        </div>

        <form
          className="shrink-0 border-t border-zinc-200 bg-zinc-50/70 p-4 dark:border-zinc-800 dark:bg-zinc-950/35"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim() && canSend && !busy) void onSend(draft, context);
          }}
        >
          {available ? (
            <>
              <AccentField>
                <textarea
                  ref={composerRef}
                  className="input min-h-24 w-full resize-none leading-6"
                  maxLength={4_000}
                  disabled={!canSend || busy}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      if (draft.trim() && canSend && !busy) void onSend(draft, context);
                    }
                  }}
                  placeholder={`Ask about ${contextName.toLowerCase()} or describe what you want changed…`}
                  aria-label="Message the planning agent"
                />
              </AccentField>
              <div className="mt-3 flex items-center justify-between gap-3">
                <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{draft.length.toLocaleString()} / 4,000 · Enter to send · Shift + Enter for a new line</span>
                <button type="submit" className="btn h-9 px-3" disabled={!canSend || busy || !draft.trim()}>Send</button>
              </div>
            </>
          ) : (
            <p className="text-xs leading-5 text-zinc-500 dark:text-zinc-400">
              {session.step === 'launched' || session.status === 'completed'
                ? 'This session is read-only. Continue implementation discussions from the Task Board.'
                : 'Discussion becomes available when the implementation plan reaches review.'}
            </p>
          )}
        </form>
      </div>
    </aside>
  );
}

function StreamingDiscussionMessage({ text }: { text: string }): JSX.Element {
  return (
    <article className="mr-auto max-w-[92%]" aria-label="Planner response streaming">
      <div className="mb-1.5 px-1 text-[11px] font-medium text-zinc-500 dark:text-zinc-400">Planner</div>
      <div className="select-text whitespace-pre-wrap break-words rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm leading-6 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
        {text}
        <span className="ml-1 inline-block h-3.5 w-px animate-pulse bg-emerald-500 align-[-1px] motion-reduce:animate-none" aria-hidden="true" />
      </div>
    </article>
  );
}

function DiscussionMessage({ message, canRespond, onChoose, onCustom, onReference }: {
  message: PlannerMessage;
  canRespond: boolean;
  onChoose: (value: string) => void;
  onCustom: () => void;
  onReference: (context: PlannerDiscussionContext) => void;
}): JSX.Element {
  const user = message.role === 'user';
  const system = message.role === 'system';
  return (
    <article className={`group/message ${user ? 'ml-auto max-w-[92%]' : 'mr-auto max-w-[92%]'}`}>
      <div className="mb-1.5 flex items-center justify-between gap-3 px-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">{user ? 'You' : system ? 'System' : 'Planner'}</span>
          {message.intent ? <span className={message.intent === 'change_request' ? 'badge-accent' : message.intent === 'clarification_needed' ? 'badge-warn' : 'badge'}>{discussionIntentLabel(message.intent)}</span> : null}
        </div>
        <CopyText value={message.content} title="Copy message" ariaLabel="Copy message" className="cursor-pointer rounded px-1.5 py-0.5 text-[10px] text-zinc-500 opacity-0 outline-none hover:bg-zinc-200 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-emerald-500 group-hover/message:opacity-100 dark:hover:bg-zinc-800">Copy</CopyText>
      </div>
      <div className={`select-text whitespace-pre-wrap break-words rounded-xl px-4 py-3 text-sm leading-6 ${user ? 'bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200' : system ? 'border border-red-200 bg-red-50/60 text-red-800 dark:border-red-900/70 dark:bg-red-950/10 dark:text-red-200' : 'border border-zinc-200 bg-white text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300'}`}>
        {message.content}
      </div>
      {message.references && message.references.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Verified plan sources">
          {message.references.map((reference) => (
            <button
              key={reference.context}
              type="button"
              className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50/60 px-2.5 py-1 text-[11px] font-medium text-emerald-800 outline-none transition-colors hover:border-emerald-400 hover:bg-emerald-100 focus-visible:ring-2 focus-visible:ring-emerald-500 dark:border-emerald-900 dark:bg-emerald-950/20 dark:text-emerald-300 dark:hover:border-emerald-700 dark:hover:bg-emerald-950/40"
              title="Show this verified source in the plan"
              onClick={() => onReference(reference.context)}
            >
              <span aria-hidden="true">↗</span>
              <span>{reference.location} → {reference.label}{reference.count === null ? '' : ` · ${reference.count} ${reference.count === 1 ? 'item' : 'items'}`}</span>
            </button>
          ))}
        </div>
      ) : null}
      {message.options ? (
        <div className="mt-2 grid gap-2">
          {message.options.map((option) => (
            <button key={option.id} type="button" className="cursor-pointer rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-left outline-none transition-colors hover:border-emerald-400 hover:bg-emerald-50/30 focus-visible:ring-2 focus-visible:ring-emerald-500 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-emerald-600 dark:hover:bg-emerald-950/10" disabled={!canRespond} onClick={() => onChoose(option.label)}>
              <span className="flex items-center justify-between gap-2 text-xs font-medium text-zinc-800 dark:text-zinc-200"><span>{option.label}</span>{option.recommended ? <span className="badge-ok">Recommended</span> : null}</span>
              <span className="mt-1 block text-xs leading-5 text-zinc-500 dark:text-zinc-400">{option.description}</span>
            </button>
          ))}
          <button type="button" className="btn-ghost justify-center text-xs" disabled={!canRespond} onClick={onCustom}>Something else…</button>
        </div>
      ) : null}
      {message.intent === 'explanation' && canRespond ? (
        <button type="button" className="mt-1.5 cursor-pointer px-1 text-[11px] font-medium text-zinc-500 outline-none hover:text-emerald-700 focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-emerald-500 dark:text-zinc-400 dark:hover:text-emerald-400" onClick={() => onChoose('Treat my previous message as a change request and prepare a reviewable revision.')}>Turn this into a change</button>
      ) : null}
    </article>
  );
}

function discussionIntentLabel(intent: NonNullable<PlannerMessage['intent']>): string {
  if (intent === 'change_request') return 'Change requested';
  if (intent === 'clarification_needed') return 'Decision needed';
  return 'Explanation';
}

function discussionContextLabel(context: PlannerDiscussionContext): string {
  const labels: Readonly<Record<PlannerDiscussionContext, string>> = {
    plan_summary: 'Whole plan',
    implementation_steps: 'Implementation steps',
    code_areas: 'Code areas',
    review_items: 'Review items',
    architecture: 'Architecture',
    data_model_and_migrations: 'Data model and migrations',
    api_and_ui: 'API and UI',
    authorization_privacy_security: 'Authorization, privacy and security',
    dependencies: 'Dependencies',
    costs: 'Potential costs',
    tests: 'Tests and validation',
    mvp: 'MVP',
    later: 'Later work',
    risks: 'Risks',
    open_decisions: 'Open decisions',
  };
  return labels[context];
}

type BriefListKey = 'audience' | 'mvp' | 'outOfScope' | 'assumptions' | 'risks' | 'openDecisions';

function GrowingTextarea({ value, onChange, disabled, className = '' }: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  className?: string;
}): JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const textarea = ref.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 320)}px`;
    textarea.style.overflowY = textarea.scrollHeight > 320 ? 'auto' : 'hidden';
  }, [value]);
  return (
    <AccentField>
      <textarea
        ref={ref}
        className={`input h-auto min-h-24 w-full resize-y leading-5 ${className}`}
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </AccentField>
  );
}

function Panel({ children }: { children: ReactNode }): JSX.Element {
  return <section className="mt-5 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 sm:p-6">{children}</section>;
}

function Setting({ label, enabled }: { label: string; enabled: boolean }): JSX.Element {
  return <li className="flex items-center justify-between"><span>{label}</span><span className={enabled ? 'badge-ok' : 'badge'}>{enabled ? 'On' : 'Off'}</span></li>;
}

function lines(value: string): string[] {
  return value.split('\n').map((line) => line.trim()).filter(Boolean);
}

function displayTitle(title: string): string {
  const normalized = title.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 104) return normalized;
  const clipped = normalized.slice(0, 103);
  const wordBoundary = clipped.lastIndexOf(' ');
  return `${clipped.slice(0, wordBoundary > 72 ? wordBoundary : clipped.length).trimEnd()}…`;
}

function friendlySessionError(error: string | null): string {
  if (!error) return 'The action failed without a detailed message. Retry the step.';
  if (error === 'The planning response did not match the expected structure. Retry this step.') {
    return 'The AI returned a response that did not fit this step\'s structured format. Nothing from that attempt was applied. Retry generates a fresh response.';
  }
  if (error.includes('Array must contain at most') || error.includes('"code": "too_big"') || error.includes('"code":"too_big"')) {
    return 'The analysis included more detail than this step could accept. Extra list items are now handled safely, so you can retry.';
  }
  if (error.trimStart().startsWith('[') && error.includes('"path"')) {
    return 'The planner returned data in an unexpected format. Retry the step to generate a new response.';
  }
  return error;
}

function friendlyTaskUpdateError(error: string): string {
  const normalized = error.toLowerCase();
  if (normalized.includes('cycle') || normalized.includes('circular')) {
    return 'These prerequisites would create a circular wait between tasks. Remove the conflicting selection and save again.';
  }
  if (normalized.includes('revision') || normalized.includes('conflict') || normalized.includes('409')) {
    return 'This plan changed in another tab. Reload the latest task values, review them, and try again.';
  }
  return 'The task could not be saved. Your editor is still open, so review the values and try again.';
}

function failedStepTitle(step: FeaturePlanningSession['step']): string {
  switch (step) {
    case 'clarification': return 'Questions could not be prepared';
    case 'artifacts_review': return 'Planning drafts could not be prepared';
    case 'analysis': return 'Plan analysis could not be completed';
    case 'refinement': return 'Tasks could not be prepared';
    case 'tasks_review': return 'Tasks could not be started';
    default: return 'This step could not be completed';
  }
}

function actionLabel(session: FeaturePlanningSession): string {
  switch (session.activeAction) {
    case 'clarifying': return 'Understanding the idea';
    case 'generating_artifacts': return 'Drafting documentation, specification and implementation plan';
    case 'creating_artifacts': return 'Creating planning artifacts';
    case 'analyzing': return 'Analyzing the plan against the codebase';
    case 'discussing': return 'Answering your planning question';
    case 'revising': return 'Preparing a reviewable revision';
    case 'decomposing': return 'Turning the plan into executable tasks';
    case 'launching': return 'Creating and queueing tasks';
    default: return 'Planning in progress';
  }
}

function revisionDiff(current: ArtifactBundle, next: ArtifactBundle): string {
  const files: Array<[keyof ArtifactBundle, string]> = [
    ['documentation', 'documentation.md'],
    ['specification', 'specification.md'],
    ['implementationPlan', 'implementation-plan.md'],
  ];
  return files
    .map(([key, path]) => oneHunkDiff(path, `# ${current[key].title}\n\n${current[key].content}`, `# ${next[key].title}\n\n${next[key].content}`))
    .filter(Boolean)
    .join('\n');
}

function oneHunkDiff(path: string, before: string, after: string): string {
  if (before === after) return '';
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix += 1;
  const contextStart = Math.max(0, prefix - 3);
  const trailing = Math.min(3, suffix);
  const oldChangeEnd = oldLines.length - suffix;
  const newChangeEnd = newLines.length - suffix;
  const oldEnd = oldChangeEnd + trailing;
  const newEnd = newChangeEnd + trailing;
  const lines = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${contextStart + 1},${oldEnd - contextStart} +${contextStart + 1},${newEnd - contextStart} @@`,
    ...oldLines.slice(contextStart, prefix).map((line) => ` ${line}`),
    ...oldLines.slice(prefix, oldChangeEnd).map((line) => `-${line}`),
    ...newLines.slice(prefix, newChangeEnd).map((line) => `+${line}`),
    ...oldLines.slice(oldChangeEnd, oldEnd).map((line) => ` ${line}`),
  ];
  return `${lines.join('\n')}\n`;
}
