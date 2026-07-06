import { useCallback, useEffect, useState } from 'react';
import type {
  PipelineRecord,
  PipelineStep,
  PipelineStepKind,
  PipelineStepSpec,
  StepDefinitionRecord,
} from '@companion/contract';
import { api, onServerMessage } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { useWorkspace } from '../lib/workspace.js';
import { Page, EmptyState, Modal, PageHeader, Section, useConfirm } from '../components/ui.js';

/**
 * Pipeline builder: compose ordered steps (inline or from the workspace's
 * custom step library) into pipelines that run against pull requests.
 */

const KIND_META: Record<PipelineStepKind, { label: string; hint: string }> = {
  'checks-gate': { label: 'CI checks gate', hint: 'Fails when GitHub pipelines are red' },
  'ai-review': { label: 'AI code review', hint: 'Built-in review agent reads the diff' },
  agent: { label: 'Custom agent', hint: 'Your prompt; agent returns pass/fail' },
  label: { label: 'Add labels', hint: 'Applies labels to the PR' },
  comment: { label: 'Post comment', hint: 'Comments on the PR (supports {{pr.title}}…)' },
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
  }
}

export function PipelinesPage(): JSX.Element {
  const { current } = useWorkspace();
  const { can } = useAuth();
  const [pipelines, setPipelines] = useState<PipelineRecord[]>([]);
  const [stepDefs, setStepDefs] = useState<StepDefinitionRecord[]>([]);
  const [editing, setEditing] = useState<PipelineRecord | 'new' | null>(null);
  const [editingDef, setEditingDef] = useState<StepDefinitionRecord | 'new' | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirmDanger, confirmElement } = useConfirm();
  const canManage = can('pipelines:manage');

  const refresh = useCallback(async () => {
    if (!current) return;
    try {
      const res = await api.workspacePipelines(current.id);
      setPipelines(res.pipelines);
      setStepDefs(res.stepDefinitions);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [current]);

  useEffect(() => {
    void refresh();
    return onServerMessage((msg) => {
      if (msg.t === 'pipelines.changed') void refresh();
    });
  }, [refresh]);

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
      {error ? <div className="error-bar">{error}</div> : null}

      <div className="flex flex-col gap-3">
        {pipelines.map((p) => (
          <article key={p.id} className="card" aria-label={p.name}>
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{p.name}</div>
                {p.description ? <p className="dim mt-0.5 truncate text-xs">{p.description}</p> : null}
              </div>
              {p.autoRunOnPrOpen ? <span className="badge-accent shrink-0">auto-run on PR open</span> : null}
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
              <div className="mt-3.5 flex items-center gap-2 border-t border-zinc-200 pt-3.5 dark:border-zinc-800">
                <button className="btn-ghost" onClick={() => setEditing(p)}>
                  Edit
                </button>
                <span className="flex-1" />
                <button
                  className="btn-danger"
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
              </div>
            ) : null}
          </article>
        ))}
      </div>
      {pipelines.length === 0 ? (
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
        {stepDefs.length === 0 ? (
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
                  <div className="mt-3.5 flex items-center gap-2 border-t border-zinc-200 pt-3.5 dark:border-zinc-800">
                    <button className="btn-ghost" onClick={() => setEditingDef(d)}>
                      Edit
                    </button>
                    <span className="flex-1" />
                    <button
                      className="btn-danger"
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
                  </div>
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
        <label className="flex flex-col gap-1 text-sm">
          <span className="dim">What to generate</span>
          <select className="input" value={target} onChange={(e) => setTarget(e.target.value as 'pipeline' | 'step')}>
            <option value="pipeline">Pipeline (ordered steps run against PRs)</option>
            <option value="step">Custom step (reusable, lands in the library)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="dim">Describe what it should do</span>
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
        </label>
        <p className="dim text-[13px]">
          A companion runner drafts it; the result opens in the editor for review. Nothing auto-runs until you enable
          it.
        </p>
        {error ? <div className="error-bar">{error}</div> : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn" type="submit" disabled={busy || instructions.trim().length < 8}>
            {busy ? 'Generating… (runs an agent turn)' : 'Generate'}
          </button>
        </div>
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
    api
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
  const [autoRun, setAutoRun] = useState(pipeline?.autoRunOnPrOpen ?? false);
  const [steps, setSteps] = useState<PipelineStepSpec[]>([...(pipeline?.steps ?? [])]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), description: description.trim(), steps, autoRunOnPrOpen: autoRun };
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
          <label className="flex flex-col gap-1 text-sm">
            <span className="dim">Name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Pre-merge gate" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="dim">Description</span>
            <input
              className="input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this pipeline verifies"
            />
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={autoRun} onChange={(e) => setAutoRun(e.target.checked)} />
          Run automatically when a PR opens in this workspace
        </label>

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
            {(Object.keys(KIND_META) as PipelineStepKind[]).map((kind) => (
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
                className="input py-1.5"
                aria-label="Add step from library"
                value=""
                onChange={(e) => {
                  if (e.target.value) {
                    setSteps((prev) => [...prev, { type: 'ref', stepDefinitionId: e.target.value }]);
                  }
                }}
              >
                <option value="">+ From library…</option>
                {stepDefs.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        </div>

        {error ? <div className="error-bar">{error}</div> : null}
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={busy || !valid} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save pipeline'}
          </button>
        </div>
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
      <label className="flex flex-col gap-1 text-sm">
        <span className="dim">Display name (optional override)</span>
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
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="dim">On failure</span>
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
      </label>
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
        <label className="flex flex-col gap-1 text-sm">
          <span className="dim">Step name</span>
          <input className="input" value={step.name} onChange={(e) => onChange({ ...step, name: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="dim">On failure</span>
          <select
            className="input"
            value={step.onFailure}
            onChange={(e) => onChange({ ...step, onFailure: e.target.value as 'halt' | 'continue' })}
          >
            <option value="halt">Stop the pipeline</option>
            <option value="continue">Continue to the next step</option>
          </select>
        </label>
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
              className="input py-1.5"
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
        <label className="flex flex-col gap-1 text-sm">
          <span className="dim">Instructions for the agent (it sees the PR, diff, and CI status)</span>
          <textarea
            className="input min-h-24 font-mono text-xs"
            value={step.config.prompt}
            placeholder="e.g. Verify the change includes tests for every new public function. Fail if any are missing."
            onChange={(e) => onChange({ ...step, config: { prompt: e.target.value } })}
          />
          <SkillsHint />
        </label>
      );
    case 'label':
      return (
        <label className="flex flex-col gap-1 text-sm">
          <span className="dim">Labels (comma-separated)</span>
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
        </label>
      );
    case 'comment':
      return (
        <label className="flex flex-col gap-1 text-sm">
          <span className="dim">Comment body — placeholders: {'{{pr.number}} {{pr.title}} {{pr.author}} {{repo}}'}</span>
          <textarea
            className="input min-h-20"
            value={step.config.body}
            onChange={(e) => onChange({ ...step, config: { body: e.target.value } })}
          />
        </label>
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
          <label className="flex flex-col gap-1 text-sm">
            <span className="dim">Step name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Security scan" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="dim">Description</span>
            <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
        </div>

        <label className="flex flex-col gap-1 text-sm">
          <span className="dim">Step type</span>
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
        </label>

        <StepForm step={step} onChange={setStep} />

        {error ? <div className="error-bar">{error}</div> : null}
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={busy || !name.trim() || !stepIsValid({ ...step, name: name.trim() || step.name })} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save step'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
