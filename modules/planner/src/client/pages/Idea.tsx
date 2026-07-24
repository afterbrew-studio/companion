import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AccentField, ChevronDown, CopyText, DiffView, EmptyState, ErrorBar, Field, Markdown, Page, PageHeader, PageLoading, QuestionIcon, SparkleIcon, Spinner, Tooltip } from '@companion/ui';
import { useAuth } from '@companion/module-core/client';
import type { ProposalAnalysis } from '@companion/module-plan/contract';
import type { RefineItemRecord, RefineItemUpdate } from '@companion/module-refinement/contract';
import type {
  ArtifactBundle,
  FeatureBrief,
  FeaturePlanningSession,
  PlannerMessage,
  PlannerQuestion,
  PlannerRevision,
} from '../../contract/index.js';
import { ideasApi } from '../api.js';
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
  const state = useIdeas(id);
  const [busy, setBusy] = useState(false);
  const [brief, setBrief] = useState<FeatureBrief | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactBundle | null>(null);
  const [artifactTab, setArtifactTab] = useState<keyof ArtifactBundle>('documentation');
  const [preview, setPreview] = useState(true);
  const [answers, setAnswers] = useState<Record<string, { optionId: string | null; value: string }>>({});
  const [revisionRequest, setRevisionRequest] = useState('');
  const [mergeIds, setMergeIds] = useState<string[]>([]);
  const session = state.detail?.session ?? null;
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
    const defaults: Record<string, { optionId: string | null; value: string }> = {};
    for (const question of session.questions) {
      const recommended = question.options.find((option) => option.recommended);
      defaults[question.id] = { optionId: recommended?.id ?? null, value: '' };
    }
    setAnswers(defaults);
  }, [questionSet]);

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    state.setError(null);
    try {
      await fn();
      await state.refresh();
    } catch (err) {
      state.setError(String(err));
      await state.refresh();
    } finally {
      setBusy(false);
    }
  };

  if (state.loading) return <PageLoading label="Loading idea…" />;
  if (state.missing || !state.detail || !session) return <EmptyState title="Idea not found" hint="It may have been removed or belong to another workspace." />;

  const canManage = can('planner:manage') && session.status !== 'completed' && session.status !== 'cancelled';
  return (
    <Page className="max-w-6xl">
      <IdeaHeader session={session} />
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
                <button className="btn-ghost" disabled={busy} onClick={() => void act(() => ideasApi.cancel(id, session.revision))}>Cancel</button>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {session.status !== 'working' && session.status !== 'failed' ? (
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
              revisionRequest={revisionRequest}
              setRevisionRequest={setRevisionRequest}
              disabled={!canManage || busy}
              onRequest={() => act(async () => {
                await ideasApi.requestRevision(id, session.revision, revisionRequest);
                setRevisionRequest('');
              })}
              onApply={() => act(() => ideasApi.applyRevision(id, session.revision))}
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
              onUpdate={(itemId, fields) => act(() => ideasApi.updateItem(id, itemId, session.revision, fields))}
              onMove={(itemId, direction) => act(() => ideasApi.moveItem(id, itemId, session.revision, direction))}
              onDismiss={(itemId) => act(() => ideasApi.dismissItem(id, itemId, session.revision))}
              onMerge={() => act(async () => {
                await ideasApi.mergeItems(id, session.revision, mergeIds);
                setMergeIds([]);
              })}
              onLaunch={() => act(() => ideasApi.launch(id, session.revision))}
              canExecute={can('planner:execute')}
            />
          ) : null}

          {session.step === 'launched' ? <Launched session={session} /> : null}
        </>
      ) : null}

      {session.messages.length > 0 ? <ConversationHistory messages={session.messages} /> : null}

      {canManage && session.status !== 'working' && session.status !== 'failed' ? (
        <div className="mt-8 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <button className="btn-danger-ghost" disabled={busy} onClick={() => void act(() => ideasApi.cancel(id, session.revision))}>Cancel planning session</button>
        </div>
      ) : null}
    </Page>
  );
}

function IdeaHeader({ session }: { session: FeaturePlanningSession }): JSX.Element {
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
        actions={<a className="btn-ghost" href="#/ideas">All ideas</a>}
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

function AnalysisReview({ analysis, artifacts, pending, revisionRequest, setRevisionRequest, disabled, onRequest, onApply, onApprove }: {
  analysis: ProposalAnalysis; artifacts: ArtifactBundle | null; pending: PlannerRevision | null; revisionRequest: string; setRevisionRequest: (value: string) => void; disabled: boolean;
  onRequest: () => Promise<void>; onApply: () => Promise<void>; onApprove: () => Promise<void>;
}): JSX.Element {
  const [activeChapterTitle, setActiveChapterTitle] = useState('Architecture and integration');
  const chapters: ReadonlyArray<AnalysisChapter> = [
    {
      title: 'Architecture and integration',
      description: 'How the feature fits the current system and its trust boundaries.',
      groups: [
        { label: 'Architecture', values: analysis.architecture },
        { label: 'Data model and migrations', values: analysis.dataModelAndMigrations },
        { label: 'API and UI', values: analysis.apiAndUi },
        { label: 'Authorization, privacy and security', values: analysis.authorizationPrivacySecurity },
      ],
    },
    {
      title: 'Code impact',
      description: 'The areas likely to change, including dependencies and cost considerations.',
      groups: [
        { label: 'Areas and files', values: analysis.touchedAreas, mono: true },
        { label: 'Dependencies', values: analysis.dependencies },
        { label: 'Potential costs', values: analysis.costs },
      ],
    },
    {
      title: 'Delivery and validation',
      description: 'The implementation sequence and how the result will be verified.',
      groups: [
        { label: 'Implementation steps', values: analysis.steps },
        { label: 'Tests', values: analysis.tests },
      ],
    },
    {
      title: 'Release boundary',
      description: 'What belongs in the first release and what is intentionally deferred.',
      groups: [
        { label: 'MVP', values: analysis.mvp },
        { label: 'Later', values: analysis.later },
      ],
    },
    {
      title: 'Risks and decisions',
      description: 'The items that can materially change scope, safety or delivery.',
      alwaysVisible: true,
      groups: [
        { label: 'Risks', values: analysis.risks, empty: 'No material risks were identified.' },
        { label: 'Open decisions', values: analysis.openDecisions, empty: 'No open decisions remain.' },
      ],
    },
  ];
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
            <AnalysisMetric label="Steps" value={analysis.steps.length} description="Implementation steps suggested by the analysis. These are not Board tasks." />
            <AnalysisMetric label="Code areas" value={analysis.touchedAreas.length} description="Files or code areas that the implementation may need to change." />
            <AnalysisMetric label="Review items" value={reviewItems} description="Risks and open decisions that deserve attention before approval." />
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
        <AnalysisChapterView key={activeChapter.title} chapter={activeChapter} />
      </section>

      {pending ? (
        <section className="border-t border-zinc-200 px-5 py-6 dark:border-zinc-800 sm:px-7">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold">Proposed revision</h3><span className="badge-accent">Waiting for approval</span></div>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-600 dark:text-zinc-300">{pending.summary}</p>
            </div>
            <button type="button" className="btn shrink-0 whitespace-nowrap" disabled={disabled} onClick={() => void onApply()}>Apply and re-analyze</button>
          </div>
          {artifacts ? <DiffView diff={revisionDiff(artifacts, pending.artifacts)} className="mt-5" /> : null}
        </section>
      ) : (
        <section className="border-t border-zinc-200 px-5 py-6 dark:border-zinc-800 sm:px-7">
          <Field label="Want something changed before approval?" hint="Describe the outcome, not the implementation. The agent will show a revision before changing any artifact.">
            <AccentField className="mt-2">
              <textarea
                className="input min-h-24 w-full resize-y leading-6"
                disabled={disabled}
                value={revisionRequest}
                onChange={(event) => setRevisionRequest(event.target.value)}
                placeholder="For example: keep analytics anonymous and avoid a paid vendor for the MVP."
              />
            </AccentField>
          </Field>
        </section>
      )}
      <footer className="flex flex-col gap-4 border-t border-zinc-200 bg-zinc-50/70 px-5 py-5 dark:border-zinc-800 dark:bg-zinc-950/35 sm:flex-row sm:items-center sm:justify-between sm:px-7">
        <p className="max-w-xl text-xs leading-5 text-zinc-500 dark:text-zinc-400">Approval locks this plan and asks the planner to prepare reviewable tasks. It does not start coding yet.</p>
        <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
          {!pending ? <button type="button" className="btn-ghost justify-center whitespace-nowrap active:translate-y-px" disabled={disabled || !revisionRequest.trim()} onClick={() => void onRequest()}>Propose changes</button> : null}
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
  readonly mono?: boolean;
  readonly empty?: string;
}

interface AnalysisChapter {
  readonly title: string;
  readonly description: string;
  readonly groups: ReadonlyArray<AnalysisGroup>;
  readonly alwaysVisible?: boolean;
}

function AnalysisMetric({ label, value, description }: { label: string; value: number; description: string }): JSX.Element {
  return (
    <Tooltip content={description} side="bottom" className="w-full min-w-0 border-r border-zinc-200 last:border-r-0 dark:border-zinc-800">
      <span
        role="listitem"
        tabIndex={0}
        aria-label={`${label}: ${value}. ${description}`}
        className="flex min-h-[4.5rem] w-full cursor-help flex-col items-center justify-center px-2 py-3 text-center outline-none transition-colors hover:bg-white/80 focus-visible:bg-white focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500 dark:hover:bg-zinc-900/70 dark:focus-visible:bg-zinc-900"
      >
        <span className="text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-100" aria-hidden="true">{value}</span>
        <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] leading-4 text-zinc-500 dark:text-zinc-400" aria-hidden="true">
          {label}
          <QuestionIcon className="size-3 text-zinc-400 dark:text-zinc-500" />
        </span>
      </span>
    </Tooltip>
  );
}

function AnalysisChapterView({ chapter }: { chapter: AnalysisChapter }): JSX.Element {
  const groups = chapter.groups.filter((group) => group.values.length > 0 || group.empty !== undefined);
  const [activeGroupLabel, setActiveGroupLabel] = useState(groups[0]!.label);
  const activeGroup = groups.find((group) => group.label === activeGroupLabel) ?? groups[0]!;
  return (
    <section className="mt-4 overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50/45 dark:border-zinc-800 dark:bg-zinc-950/20">
      <header className="border-b border-zinc-200 px-5 py-5 dark:border-zinc-800 sm:px-6">
        <h4 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{chapter.title}</h4>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-zinc-500 dark:text-zinc-400">{chapter.description}</p>
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
    <section className="mx-auto max-w-3xl">
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

function TaskReview({ session, items, board, mergeIds, setMergeIds, disabled, onUpdate, onMove, onDismiss, onMerge, onLaunch, canExecute }: {
  session: FeaturePlanningSession; items: ReadonlyArray<RefineItemRecord>;
  board: NonNullable<ReturnType<typeof useIdeas>['detail']>['board']; mergeIds: string[]; setMergeIds: (ids: string[]) => void; disabled: boolean;
  onUpdate: (itemId: string, fields: RefineItemUpdate) => Promise<void>; onMove: (itemId: string, direction: 'up' | 'down') => Promise<void>;
  onDismiss: (itemId: string) => Promise<void>; onMerge: () => Promise<void>; onLaunch: () => Promise<void>; canExecute: boolean;
}): JSX.Element {
  const proposed = items.filter((item) => item.status === 'proposed');
  const developers = board.workers.filter((worker) => worker.enabled && worker.role === 'developer');
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <Panel>
        <h2 className="text-lg font-semibold">Review tasks</h2>
        <p className="dim mt-1 text-sm">Edit wording, priority, dependencies and order. Imported tasks are locked.</p>
        <div className="mt-5 grid gap-3">{items.map((item, index) => <TaskEditor key={item.id} item={item} index={index} items={items} selected={mergeIds.includes(item.id)} disabled={disabled} onSelect={(selected) => setMergeIds(selected ? [...mergeIds, item.id] : mergeIds.filter((id) => id !== item.id))} onUpdate={onUpdate} onMove={onMove} onDismiss={onDismiss} />)}</div>
        {mergeIds.length > 1 ? <div className="mt-4 flex justify-end"><button className="btn-ghost" disabled={disabled} onClick={() => void onMerge()}>Merge {mergeIds.length} selected tasks</button></div> : null}
      </Panel>
      <aside className="space-y-4">
        <Panel>
          <h2 className="font-semibold">Launch summary</h2>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm"><dt className="dim">Tasks</dt><dd>{proposed.length}</dd><dt className="dim">Repository</dt><dd className="break-all font-mono text-xs">{session.repo}</dd><dt className="dim">Branch</dt><dd className="font-mono text-xs">{session.branch}</dd><dt className="dim">Developers</dt><dd>{developers.length}</dd></dl>
        </Panel>
        <Panel>
          <h2 className="font-semibold">Board automation</h2>
          <ul className="mt-3 space-y-2 text-sm"><Setting label="Auto review" enabled={board.config.autoReview} /><Setting label="Auto-fix CI" enabled={board.config.autoFixCi} /><Setting label={`Auto merge (${board.config.mergeMethod})`} enabled={board.config.autoMerge} /></ul>
          {board.config.autoMerge ? <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">Auto-merge is enabled. Approved work with green checks may merge without another manual confirmation.</p> : null}
          {developers.length === 0 ? <p className="mt-3 rounded-lg bg-zinc-100 p-3 text-xs dark:bg-zinc-800">No developer worker is available. Tasks will remain Ready and start automatically when a worker becomes available.</p> : null}
        </Panel>
        <div className="rounded-xl border-2 border-zinc-900 p-4 dark:border-zinc-100"><p className="text-sm font-semibold">This starts real agent work</p><p className="dim mt-1 text-xs">Tasks are created with queue enabled and become read-only here.</p><button className="btn mt-4 w-full justify-center" disabled={disabled || !canExecute || proposed.length === 0} onClick={() => void onLaunch()}>Create tasks & start work</button></div>
      </aside>
    </div>
  );
}

function TaskEditor({ item, index, items, selected, disabled, onSelect, onUpdate, onMove, onDismiss }: {
  item: RefineItemRecord; index: number; items: ReadonlyArray<RefineItemRecord>; selected: boolean; disabled: boolean;
  onSelect: (selected: boolean) => void; onUpdate: (itemId: string, fields: RefineItemUpdate) => Promise<void>;
  onMove: (itemId: string, direction: 'up' | 'down') => Promise<void>; onDismiss: (itemId: string) => Promise<void>;
}): JSX.Element {
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description);
  const [acceptance, setAcceptance] = useState(item.acceptance);
  const [priority, setPriority] = useState(item.priority);
  const byOrd = useMemo(() => new Map(items.map((entry) => [entry.ord, entry.id])), [items]);
  const [dependsOnIds, setDependsOnIds] = useState<string[]>(item.dependsOn.flatMap((ord) => byOrd.get(ord) ? [byOrd.get(ord)!] : []));
  useEffect(() => { setTitle(item.title); setDescription(item.description); setAcceptance(item.acceptance); setPriority(item.priority); setDependsOnIds(item.dependsOn.flatMap((ord) => byOrd.get(ord) ? [byOrd.get(ord)!] : [])); }, [item, byOrd]);
  const editable = item.status === 'proposed' && !disabled;
  return (
    <article className={`rounded-xl border p-4 ${item.status === 'proposed' ? 'border-zinc-200 dark:border-zinc-800' : 'border-zinc-100 opacity-70 dark:border-zinc-800'}`}>
      <div className="flex items-center gap-2"><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={selected} disabled={!editable} onChange={(event) => onSelect(event.target.checked)} /> merge</label><span className="badge">#{index + 1}</span><span className="badge">{item.status}</span><span className="flex-1" /><button className="btn-ghost h-8 px-2" disabled={!editable || index === 0} aria-label="Move task up" onClick={() => void onMove(item.id, 'up')}>↑</button><button className="btn-ghost h-8 px-2" disabled={!editable || index === items.length - 1} aria-label="Move task down" onClick={() => void onMove(item.id, 'down')}>↓</button></div>
      <div className="mt-3 grid gap-3"><Field label="Title"><AccentField><input className="input w-full" disabled={!editable} value={title} onChange={(event) => setTitle(event.target.value)} /></AccentField></Field><Field label="Description"><AccentField><textarea className="input min-h-20 w-full" disabled={!editable} value={description} onChange={(event) => setDescription(event.target.value)} /></AccentField></Field><Field label="Acceptance criteria"><AccentField><textarea className="input min-h-20 w-full" disabled={!editable} value={acceptance} onChange={(event) => setAcceptance(event.target.value)} /></AccentField></Field>
        <div className="grid gap-3 sm:grid-cols-2"><Field label="Priority"><select className="input" disabled={!editable} value={priority} onChange={(event) => setPriority(Number(event.target.value) as 0 | 1 | 2 | 3)}>{[0, 1, 2, 3].map((value) => <option key={value} value={value}>P{value}</option>)}</select></Field><Field label="Dependencies"><select multiple className="input min-h-24" disabled={!editable} value={dependsOnIds} onChange={(event) => setDependsOnIds([...event.target.selectedOptions].map((option) => option.value))}>{items.filter((candidate) => candidate.id !== item.id && candidate.status !== 'dismissed').map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}</select></Field></div>
      </div>
      {item.status === 'proposed' ? <div className="mt-4 flex justify-end gap-2"><button className="btn-danger-ghost" disabled={!editable} onClick={() => void onDismiss(item.id)}>Dismiss</button><button className="btn-ghost" disabled={!editable || !title.trim()} onClick={() => void onUpdate(item.id, { title, description, acceptance, priority, dependsOnIds })}>Save task</button></div> : item.taskId ? <a className="mt-3 inline-block text-sm underline" href={`#/board?task=${encodeURIComponent(item.taskId)}`}>Open task {item.taskId}</a> : null}
    </article>
  );
}

function Launched({ session }: { session: FeaturePlanningSession }): JSX.Element {
  return <Panel><span className="badge-ok">Work started</span><h2 className="mt-3 text-xl font-semibold">Tasks are now managed by the Board</h2><p className="dim mt-2 text-sm">This planning session is preserved as read-only history. Continue edits, reviews and agent operations from the task cards.</p><div className="mt-5 flex flex-wrap gap-2"><a className="btn" href="#/board">Open Task Board</a>{session.taskIds.map((taskId) => <a key={taskId} className="btn-ghost" href={`#/board?task=${encodeURIComponent(taskId)}`}>{taskId}</a>)}</div></Panel>;
}

function ConversationHistory({ messages }: { messages: ReadonlyArray<PlannerMessage> }): JSX.Element {
  return (
    <details className="group mt-5 rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-2xl p-5 outline-none focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-zinc-950 sm:p-6 [&::-webkit-details-marker]:hidden">
        <span>
          <span className="block text-base font-semibold">Planning conversation</span>
          <span className="mt-1 block text-xs leading-5 text-zinc-500 dark:text-zinc-400">Review the decisions and answers saved with this idea.</span>
        </span>
        <span className="shrink-0 text-xs font-medium text-zinc-600 group-open:hidden dark:text-zinc-300">Show {messages.length} messages</span>
        <span className="hidden shrink-0 text-xs font-medium text-zinc-600 group-open:inline dark:text-zinc-300">Hide messages</span>
      </summary>
      <div className="max-h-[32rem] space-y-3 overflow-y-auto border-t border-zinc-200 p-5 dark:border-zinc-800 sm:p-6">
        {messages.map((message) => (
          <article key={message.id} className={`rounded-xl p-4 text-sm ${message.role === 'user' ? 'ml-auto max-w-[90%] bg-zinc-100 dark:bg-zinc-800' : 'mr-auto max-w-[90%] border border-zinc-200 dark:border-zinc-800'}`}>
            <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">{message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Planner' : 'System'}</p>
            <p className="whitespace-pre-wrap leading-6">{message.content}</p>
          </article>
        ))}
      </div>
    </details>
  );
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
