import { useEffect, useState } from 'react';
import { useAuth } from '@companion/module-core/client';
import { operateApi } from '@companion/module-operate/client';
import { useWorkspace } from '@companion/module-workspace/client';
import { CardActions, EmptyState, ErrorBar, Field, FormActions, Modal, Page, PageHeader, RowsSkeleton, Section, useConfirm } from '@companion/ui';
import type {
  PipelineRecord,
  PipelineStep,
  PipelineStepKind,
  PipelineStepSpec,
  PipelineType,
  StepDefinitionRecord,
} from '../../contract/index.js';
import { PIPELINE_TYPE_STEPS } from '../../contract/index.js';
import { codeApi as api } from '../api.js';
import { usePipelines } from '../hooks/usePipelines.js';

/**
 * Pipeline builder: compose ordered steps (inline or from the workspace's
 * custom step library) into pipelines that run against pull requests.
 */

const TYPE_META: Record<PipelineType, { label: string; hint: string; autoRun: string }> = {
  pr: {
    label: 'PR pipeline',
    hint: 'Runs against a pull request — CI gate, AI review, agents, labels, comments',
    autoRun: 'Run automatically when a PR opens in this workspace',
  },
  issue: {
    label: 'Issue pipeline',
    hint: 'Runs against an issue — agents, labels, comments',
    autoRun: 'Run automatically when an issue opens in this workspace',
  },
  platform: {
    label: 'Platform pipeline',
    hint: 'Runs against a repo with no issue/PR payload — agent steps only',
    autoRun: '',
  },
};

const KIND_META: Record<PipelineStepKind, { label: string; hint: string }> = {
  'checks-gate': { label: 'CI checks gate', hint: 'Fails when GitHub pipelines are red' },
  'ai-review': { label: 'AI code review', hint: 'Built-in review agent reads the diff' },
  agent: { label: 'Custom agent', hint: 'Your prompt; agent returns pass/fail' },
  label: { label: 'Add labels', hint: 'Applies labels to the PR' },
  comment: { label: 'Post comment', hint: 'Comments on the PR (supports {{pr.title}}…)' },
  'slop-check': { label: 'AI slop gate', hint: 'Fails when the slop score reaches the threshold (needs the Slop module)' },
};

function defaultStep(kind: PipelineStepKind): PipelineStep {
  const base = { name: KIND_META[kind].label, onFailure: 'halt' as const };
  switch (kind) {
    case 'checks-gate':
      return { ...base, kind, config: { allowPending: false } };
    case 'ai-review':
      return { ...base, kind, config: { post: false, failOn: 'high_risk' } };
    case 'agent':
      return { ...base, kind, config: { prompt: '' } };
    case 'label':
      return { ...base, kind, config: { labels: [] } };
    case 'comment':
      return { ...base, kind, config: { body: '' } };
    case 'slop-check':
      return { ...base, kind, config: { threshold: 70 } };
  }
}

export function PipelinesPage(): JSX.Element {
  const { current, pipelines, stepDefs, loaded, error, setError, refresh } = usePipelines();
  const { can } = useAuth();
  const [editing, setEditing] = useState<PipelineRecord | 'new' | null>(null);
  const [editingDef, setEditingDef] = useState<StepDefinitionRecord | 'new' | null>(null);
  const [generating, setGenerating] = useState(false);
  const { confirmDanger, confirmElement } = useConfirm();
  const canManage = can('pipelines:manage');

  if (!current) return <EmptyState title="No workspace selected" />;

  return (
    <Page>
      <PageHeader
        title="Pipelines"
        subtitle={`${current.name} — run against any pull request, or automatically when a PR opens`}
        actions={
          canManage ? (
            <>
              <button className="btn-ghost" onClick={() => setGenerating(true)}>
                ✦ Generate with AI
              </button>
              <button className="btn-ghost" onClick={() => setEditingDef('new')}>
                New custom step
              </button>
              <button className="btn" onClick={() => setEditing('new')}>
                New pipeline
              </button>
            </>
          ) : undefined
        }
      />
      <ErrorBar error={error} />

      <div className="flex flex-col gap-3">
        {!loaded ? (
          <div className="card">
            <RowsSkeleton rows={2} />
          </div>
        ) : null}
        {pipelines.map((p) => (
          <article key={p.id} className="card" aria-label={p.name}>
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{p.name}</div>
                <p className="dim mt-0.5 truncate text-xs">
                  {TYPE_META[p.type].label}
                  {p.description ? ` · ${p.description}` : ''}
                </p>
              </div>
              {p.autoRunOnPrOpen ? (
                <span className="badge-accent shrink-0">
                  auto-run on {p.type === 'issue' ? 'issue' : 'PR'} open
                </span>
              ) : null}
            </div>
            <ol className="mt-3 flex flex-wrap items-center gap-1.5" aria-label={`${p.name} steps`}>
              {p.steps.map((spec, i) => {
                const label =
                  spec.type === 'inline'
                    ? spec.step.name
                    : (spec.overrides?.name ??
                      stepDefs.find((d) => d.id === spec.stepDefinitionId)?.name ??
                      'missing step');
                const isRef = spec.type === 'ref';
                return (
                  <li key={i} className="flex items-center gap-1.5">
                    {i > 0 ? <span className="dim">→</span> : null}
                    <span className={isRef ? 'badge-accent normal-case' : 'badge normal-case'} title={isRef ? 'from step library' : undefined}>
                      {label}
                    </span>
                  </li>
                );
              })}
            </ol>
            {canManage ? (
              <CardActions>
                <button className="btn-ghost" onClick={() => setEditing(p)}>
                  Edit
                </button>
                {p.type === 'platform' && can('pipelines:run') ? (
                  <PlatformRunButton pipeline={p} onError={setError} />
                ) : null}
                <span className="action-sep" aria-hidden />
                <button
                  className="btn-danger-ghost"
                  onClick={() =>
                    void (async () => {
                      const ok = await confirmDanger({
                        title: `Delete pipeline ${p.name}`,
                        message: `"${p.name}" stops running against pull requests. Its run history is kept.`,
                      });
                      if (ok) await api.deletePipeline(p.id).then(refresh).catch((e) => setError(String(e)));
                    })()
                  }
                >
                  Delete
                </button>
              </CardActions>
            ) : null}
          </article>
        ))}
      </div>
      {loaded && pipelines.length === 0 ? (
        <EmptyState
          title="No pipelines yet"
          hint="A pipeline is an ordered set of steps — CI gate, AI review, custom agents, labels, comments — that you run against pull requests."
          action={
            canManage ? (
              <button className="btn" onClick={() => setEditing('new')}>
                Create the first pipeline
              </button>
            ) : undefined
          }
        />
      ) : null}

      <Section
        title="Custom step library"
        description="Reusable steps shared by every pipeline in this workspace. Editing a library step updates all pipelines that reference it."
      >
        {!loaded ? (
          <div className="card">
            <RowsSkeleton rows={2} />
          </div>
        ) : null}
        {loaded && stepDefs.length === 0 ? (
          <EmptyState
            title="No custom steps yet"
            hint="Custom steps let you reuse an agent prompt or gate across pipelines."
            action={
              canManage ? (
                <button className="btn" onClick={() => setEditingDef('new')}>
                  Create a custom step
                </button>
              ) : undefined
            }
          />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {stepDefs.map((d) => (
              <article key={d.id} className="card" aria-label={d.name}>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{d.name}</div>
                  <div className="dim mt-0.5 text-xs">{KIND_META[d.step.kind].label}</div>
                </div>
                {d.description ? <p className="dim mt-2 line-clamp-2 text-[13px]">{d.description}</p> : null}
                {canManage ? (
                  <CardActions>
                    <button className="btn-ghost" onClick={() => setEditingDef(d)}>
                      Edit
                    </button>
                    <span className="action-sep" aria-hidden />
                    <button
                      className="btn-danger-ghost"
                      onClick={() =>
                        void (async () => {
                          const ok = await confirmDanger({
                            title: `Delete step ${d.name}`,
                            message: `Pipelines referencing "${d.name}" will fail to resolve it until they are edited.`,
                          });
                          if (ok) await api.deleteStepDefinition(d.id).then(refresh).catch((e) => setError(String(e)));
                        })()
                      }
                    >
                      Delete
                    </button>
                  </CardActions>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </Section>

      {editing ? (
        <PipelineEditor
          workspaceId={current.id}
          pipeline={editing === 'new' ? null : editing}
          stepDefs={stepDefs}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void refresh();
          }}
        />
      ) : null}
      {editingDef ? (
        <StepDefinitionEditor
          workspaceId={current.id}
          definition={editingDef === 'new' ? null : editingDef}
          onClose={() => setEditingDef(null)}
          onSaved={() => {
            setEditingDef(null);
            void refresh();
          }}
        />
      ) : null}
      {confirmElement}
      {generating ? (
        <GenerateModal
          workspaceId={current.id}
          onClose={() => setGenerating(false)}
          onPipeline={(p) => {
            setGenerating(false);
            void refresh().then(() => setEditing(p));
          }}
          onStepDefinition={(d) => {
            setGenerating(false);
            void refresh().then(() => setEditingDef(d));
          }}
        />
      ) : null}
    </Page>
  );
}

/**
 * "Generate with AI": a bounded companion runner drafts a pipeline or custom
 * step from plain language; the created draft opens in the editor for review.
 * Generated pipelines never auto-run until a human enables it.
 */
function GenerateModal({
  workspaceId,
  onClose,
  onPipeline,
  onStepDefinition,
}: {
  workspaceId: string;
  onClose: () => void;
  onPipeline: (p: PipelineRecord) => void;
  onStepDefinition: (d: StepDefinitionRecord) => void;
}): JSX.Element {
  const [target, setTarget] = useState<'pipeline' | 'step'>('pipeline');
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (target === 'pipeline') {
        const { pipeline } = await api.generatePipeline(workspaceId, instructions.trim());
        onPipeline(pipeline);
      } else {
        const { stepDefinition } = await api.generateStepDefinition(workspaceId, instructions.trim());
        onStepDefinition(stepDefinition);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="✦ Generate with AI" onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <Field label="What to generate">
          <select className="input" value={target} onChange={(e) => setTarget(e.target.value as 'pipeline' | 'step')}>
            <option value="pipeline">Pipeline (ordered steps run against PRs)</option>
            <option value="step">Custom step (reusable, lands in the library)</option>
          </select>
        </Field>
        <Field label="Describe what it should do">
          <textarea
            className="input min-h-28 resize-y"
            required
            minLength={8}
            placeholder={
              target === 'pipeline'
                ? 'e.g. gate on green CI, then AI-review with posting on, then label security PRs'
                : 'e.g. an agent step that fails when the diff touches the payments module without tests'
            }
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            autoFocus
          />
        </Field>
        <p className="dim text-[13px]">
          A companion runner drafts it; the result opens in the editor for review. Nothing auto-runs until you enable
          it.
        </p>
        <ErrorBar error={error} />
        <FormActions>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn" type="submit" disabled={busy || instructions.trim().length < 8}>
            {busy ? 'Generating… (runs an agent turn)' : 'Generate'}
          </button>
        </FormActions>
      </form>
    </Modal>
  );
}

/**
 * Skills live in the moxxy home and are auto-discovered by every agent run —
 * mentioning one by name in a step prompt is enough to apply it.
 */
function SkillsHint(): JSX.Element | null {
  const [names, setNames] = useState<string[] | null>(null);
  useEffect(() => {
    operateApi
      .listSkills()
      .then(({ skills }) => setNames(skills.map((sk) => sk.name)))
      .catch(() => setNames(null)); // no skills:manage — hint just stays hidden
  }, []);
  if (!names || names.length === 0) return null;
  return (
    <p className="dim text-xs">
      The agent auto-discovers your skills — mention one by name to apply it:{' '}
      <code className="text-[11px]">{names.join(', ')}</code>
    </p>
  );
}

/** Run a platform pipeline against a repo of the workspace. */
function PlatformRunButton({
  pipeline,
  onError,
}: {
  pipeline: PipelineRecord;
  onError: (e: string) => void;
}): JSX.Element {
  const { current } = useWorkspace();
  const [repos, setRepos] = useState<string[]>([]);
  const [repo, setRepo] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!current) return;
    api
      .workspaceRepos(current.id)
      .then((r) => {
        const names = r.repos.map((x) => x.fullName);
        setRepos(names);
        setRepo((prev) => prev || (names[0] ?? ''));
      })
      .catch(() => setRepos([]));
  }, [current]);

  if (repos.length === 0) return <span className="dim text-xs">connect a repo to run</span>;

  const run = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.runPlatformPipeline(repo, pipeline.id);
    } catch (err) {
      onError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="flex items-center gap-2">
      {repos.length > 1 ? (
        <select className="input" aria-label="Repo to run against" value={repo} onChange={(e) => setRepo(e.target.value)}>
          {repos.map((r) => (
            <option key={r} value={r}>
              {r.split('/')[1]}
            </option>
          ))}
        </select>
      ) : null}
      <button className="btn-ghost" disabled={busy || !repo} onClick={() => void run()}>
        {busy ? 'Starting…' : 'Run now'}
      </button>
    </span>
  );
}

// ---------- pipeline editor ---------------------------------------------------------

function PipelineEditor({
  workspaceId,
  pipeline,
  stepDefs,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  pipeline: PipelineRecord | null;
  stepDefs: StepDefinitionRecord[];
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const [name, setName] = useState(pipeline?.name ?? '');
  const [description, setDescription] = useState(pipeline?.description ?? '');
  const [type, setType] = useState<PipelineType>(pipeline?.type ?? 'pr');
  const [autoRun, setAutoRun] = useState(pipeline?.autoRunOnPrOpen ?? false);
  const [steps, setSteps] = useState<PipelineStepSpec[]>([...(pipeline?.steps ?? [])]);
  const allowedKinds = PIPELINE_TYPE_STEPS[type];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const body = {
        type,
        name: name.trim(),
        description: description.trim(),
        steps,
        autoRunOnPrOpen: type === 'platform' ? false : autoRun,
      };
      if (pipeline) await api.updatePipeline(pipeline.id, body);
      else await api.createPipeline(workspaceId, body);
      onSaved();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  const updateStep = (index: number, spec: PipelineStepSpec): void =>
    setSteps((prev) => prev.map((s, i) => (i === index ? spec : s)));
  const removeStep = (index: number): void => setSteps((prev) => prev.filter((_, i) => i !== index));
  const moveStep = (index: number, delta: -1 | 1): void =>
    setSteps((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item!);
      return next;
    });

  const valid =
    name.trim().length > 0 &&
    steps.length > 0 &&
    steps.every((s) => (s.type === 'inline' ? stepIsValid(s.step) : true));

  return (
    <Modal title={pipeline ? `Edit pipeline — ${pipeline.name}` : 'New pipeline'} onClose={onClose} wide>
      <div className="flex flex-col gap-3">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Name">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Pre-merge gate" />
          </Field>
          <Field label="Description">
            <input
              className="input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this pipeline verifies"
            />
          </Field>
        </div>
        <Field label="Type — decides the payload and which steps are allowed">
          <select
            className="input"
            value={type}
            onChange={(e) => {
              const next = e.target.value as PipelineType;
              setType(next);
              // Drop inline steps the new type cannot run.
              setSteps((prev) =>
                prev.filter((sp) => sp.type !== 'inline' || PIPELINE_TYPE_STEPS[next].includes(sp.step.kind)),
              );
              if (next === 'platform') setAutoRun(false);
            }}
          >
            {(Object.keys(TYPE_META) as PipelineType[]).map((t) => (
              <option key={t} value={t}>
                {TYPE_META[t].label} — {TYPE_META[t].hint}
              </option>
            ))}
          </select>
        </Field>
        {type !== 'platform' ? (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={autoRun} onChange={(e) => setAutoRun(e.target.checked)} />
            {TYPE_META[type].autoRun}
          </label>
        ) : null}

        <div>
          <div className="mb-1.5 text-sm font-medium">Steps</div>
          <ol className="flex flex-col gap-2">
            {steps.map((spec, i) => (
              <li key={i} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-700">
                <div className="mb-2 flex items-center gap-2">
                  <span className="dim w-5 text-right tabular-nums">{i + 1}.</span>
                  {spec.type === 'ref' ? (
                    <span className="badge-accent normal-case">
                      library: {stepDefs.find((d) => d.id === spec.stepDefinitionId)?.name ?? 'missing'}
                    </span>
                  ) : (
                    <span className="badge normal-case">{KIND_META[spec.step.kind].label}</span>
                  )}
                  <span className="flex-1" />
                  <button className="btn-ghost" onClick={() => moveStep(i, -1)} disabled={i === 0} aria-label="Move step up">
                    ↑
                  </button>
                  <button
                    className="btn-ghost"
                    onClick={() => moveStep(i, 1)}
                    disabled={i === steps.length - 1}
                    aria-label="Move step down"
                  >
                    ↓
                  </button>
                  <button className="btn-ghost" onClick={() => removeStep(i)} aria-label="Remove step">
                    ✕
                  </button>
                </div>
                {spec.type === 'inline' ? (
                  <StepForm step={spec.step} onChange={(step) => updateStep(i, { type: 'inline', step })} />
                ) : (
                  <RefForm
                    spec={spec}
                    stepDefs={stepDefs}
                    onChange={(next) => updateStep(i, next)}
                  />
                )}
              </li>
            ))}
          </ol>

          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {(Object.keys(KIND_META) as PipelineStepKind[]).filter((kind) => allowedKinds.includes(kind)).map((kind) => (
              <button
                key={kind}
                className="btn-ghost"
                title={KIND_META[kind].hint}
                onClick={() => setSteps((prev) => [...prev, { type: 'inline', step: defaultStep(kind) }])}
              >
                + {KIND_META[kind].label}
              </button>
            ))}
            {stepDefs.length > 0 ? (
              <select
                className="input"
                aria-label="Add step from library"
                value=""
                onChange={(e) => {
                  if (e.target.value) {
                    setSteps((prev) => [...prev, { type: 'ref', stepDefinitionId: e.target.value }]);
                  }
                }}
              >
                <option value="">+ From library…</option>
                {stepDefs
                  .filter((d) => allowedKinds.includes(d.step.kind))
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
              </select>
            ) : null}
          </div>
        </div>

        <ErrorBar error={error} />
        <FormActions>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={busy || !valid} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save pipeline'}
          </button>
        </FormActions>
      </div>
    </Modal>
  );
}

function RefForm({
  spec,
  stepDefs,
  onChange,
}: {
  spec: Extract<PipelineStepSpec, { type: 'ref' }>;
  stepDefs: StepDefinitionRecord[];
  onChange: (spec: PipelineStepSpec) => void;
}): JSX.Element {
  const def = stepDefs.find((d) => d.id === spec.stepDefinitionId);
  return (
    <div className="grid gap-2 md:grid-cols-2">
      <Field label="Display name (optional override)">
        <input
          className="input"
          value={spec.overrides?.name ?? ''}
          placeholder={def?.name ?? ''}
          onChange={(e) =>
            onChange({
              ...spec,
              overrides: { ...spec.overrides, name: e.target.value || undefined },
            })
          }
        />
      </Field>
      <Field label="On failure">
        <select
          className="input"
          value={spec.overrides?.onFailure ?? def?.step.onFailure ?? 'halt'}
          onChange={(e) =>
            onChange({
              ...spec,
              overrides: { ...spec.overrides, onFailure: e.target.value as 'halt' | 'continue' },
            })
          }
        >
          <option value="halt">Stop the pipeline</option>
          <option value="continue">Continue to the next step</option>
        </select>
      </Field>
    </div>
  );
}

// ---------- step form (shared by inline steps + library editor) ---------------------

function stepIsValid(step: PipelineStep): boolean {
  if (!step.name.trim()) return false;
  switch (step.kind) {
    case 'agent':
      return step.config.prompt.trim().length > 0;
    case 'label':
      return step.config.labels.length > 0;
    case 'comment':
      return step.config.body.trim().length > 0;
    default:
      return true;
  }
}

function StepForm({ step, onChange }: { step: PipelineStep; onChange: (s: PipelineStep) => void }): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <div className="grid gap-2 md:grid-cols-2">
        <Field label="Step name">
          <input className="input" value={step.name} onChange={(e) => onChange({ ...step, name: e.target.value })} />
        </Field>
        <Field label="On failure">
          <select
            className="input"
            value={step.onFailure}
            onChange={(e) => onChange({ ...step, onFailure: e.target.value as 'halt' | 'continue' })}
          >
            <option value="halt">Stop the pipeline</option>
            <option value="continue">Continue to the next step</option>
          </select>
        </Field>
      </div>
      <StepConfigForm step={step} onChange={onChange} />
    </div>
  );
}

function StepConfigForm({ step, onChange }: { step: PipelineStep; onChange: (s: PipelineStep) => void }): JSX.Element {
  switch (step.kind) {
    case 'checks-gate':
      return (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={step.config.allowPending}
            onChange={(e) => onChange({ ...step, config: { allowPending: e.target.checked } })}
          />
          Pass while checks are still running (only fail on red)
        </label>
      );
    case 'ai-review':
      return (
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={step.config.post}
              onChange={(e) => onChange({ ...step, config: { ...step.config, post: e.target.checked } })}
            />
            Post the review to GitHub
          </label>
          <label className="flex items-center gap-2">
            <span className="dim">Fail when</span>
            <select
              className="input input-sm"
              value={step.config.failOn}
              onChange={(e) =>
                onChange({
                  ...step,
                  config: { ...step.config, failOn: e.target.value as 'request_changes' | 'high_risk' | 'never' },
                })
              }
            >
              <option value="high_risk">risk is high</option>
              <option value="request_changes">changes are requested</option>
              <option value="never">never (informational)</option>
            </select>
          </label>
        </div>
      );
    case 'agent':
      return (
        <Field label="Instructions for the agent (it sees the PR, diff, and CI status)">
          <textarea
            className="input min-h-24 font-mono text-xs"
            value={step.config.prompt}
            placeholder="e.g. Verify the change includes tests for every new public function. Fail if any are missing."
            onChange={(e) => onChange({ ...step, config: { prompt: e.target.value } })}
          />
          <SkillsHint />
        </Field>
      );
    case 'label':
      return (
        <Field label="Labels (comma-separated)">
          <input
            className="input"
            value={step.config.labels.join(', ')}
            placeholder="needs-qa, pipeline-checked"
            onChange={(e) =>
              onChange({
                ...step,
                config: { labels: e.target.value.split(',').map((l) => l.trim()).filter(Boolean) },
              })
            }
          />
        </Field>
      );
    case 'comment':
      return (
        <Field label={`Comment body — placeholders: ${'{{pr.number}} {{pr.title}} {{pr.author}} {{repo}}'}`}>
          <textarea
            className="input min-h-20"
            value={step.config.body}
            onChange={(e) => onChange({ ...step, config: { body: e.target.value } })}
          />
        </Field>
      );
    case 'slop-check':
      return (
        <Field label="Fail at AI likelihood (1–100) — runs a fresh detection; the verdict also lands on the Slop page">
          <input
            type="number"
            className="input w-28"
            min={1}
            max={100}
            value={step.config.threshold}
            onChange={(e) =>
              onChange({ ...step, config: { threshold: Math.min(100, Math.max(1, Number(e.target.value) || 1)) } })
            }
          />
        </Field>
      );
  }
}

// ---------- step definition editor ---------------------------------------------------

function StepDefinitionEditor({
  workspaceId,
  definition,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  definition: StepDefinitionRecord | null;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const [name, setName] = useState(definition?.name ?? '');
  const [description, setDescription] = useState(definition?.description ?? '');
  const [step, setStep] = useState<PipelineStep>(definition?.step ?? defaultStep('agent'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), description: description.trim(), step: { ...step, name: name.trim() } };
      if (definition) await api.updateStepDefinition(definition.id, body);
      else await api.createStepDefinition(workspaceId, body);
      onSaved();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={definition ? `Edit step — ${definition.name}` : 'New custom step'} onClose={onClose} wide>
      <div className="flex flex-col gap-3">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Step name">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Security scan" />
          </Field>
          <Field label="Description">
            <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </div>

        <Field label="Step type">
          <select
            className="input"
            value={step.kind}
            onChange={(e) => setStep(defaultStep(e.target.value as PipelineStepKind))}
          >
            {(Object.keys(KIND_META) as PipelineStepKind[]).map((kind) => (
              <option key={kind} value={kind}>
                {KIND_META[kind].label}
              </option>
            ))}
          </select>
        </Field>

        <StepForm step={step} onChange={setStep} />

        <ErrorBar error={error} />
        <FormActions>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={busy || !name.trim() || !stepIsValid({ ...step, name: name.trim() || step.name })} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save step'}
          </button>
        </FormActions>
      </div>
    </Modal>
  );
}
