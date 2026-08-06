import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@companion/module-core/client';
import { operateApi } from '@companion/module-operate/client';
import { encodeIntegrationTarget, ReviewProviderSelect } from '@companion/module-integrations/client';
import { useWorkspace } from '@companion/module-workspace/client';
import { ActionMenu, CardActions, EmptyState, ErrorBar, Field, FormActions, Modal, Page, PageHeader, RowsSkeleton, rowDelay, Section, useConfirm, useSettledFlag } from '@moxxy/companion-sdk/ui';
import type {
  ImportPreview,
  PrActionId,
  PipelineRecord,
  StepVariable,
  PipelineStep,
  PipelineStepKind,
  PipelineStepSpec,
  PipelineType,
  StepDefinitionRecord,
} from '../../contract/index.js';
import { PIPELINE_TYPE_STEPS } from '../../contract/index.js';
import { codeApi as api } from '../api.js';
import { PipelineRunList } from '../components/PipelineRunList.js';
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
  'ai-review': { label: 'Code review', hint: 'Use the repository route or pin a connected review provider' },
  agent: { label: 'Custom agent', hint: 'Your prompt; agent returns pass/fail' },
  label: { label: 'Add labels', hint: 'Applies labels to the PR' },
  comment: { label: 'Post comment', hint: 'Comments on the PR (supports {{pr.title}}…)' },
  'slop-check': {
    label: 'PR quality gate',
    hint: 'Screens AI likelihood, contribution value, test evidence, technical risk, and reviewability (needs Slop)',
  },
  executable: {
    label: '[unsafe] Run command',
    hint: 'Runs a shell command as the daemon user. Needs pipelines:execute and the instance switch',
  },
  'npm-bootstrap': {
    label: '[unsafe] npm bootstrap',
    hint: 'Publishes packages the registry is missing and registers trusted publishing. Irreversible',
  },
  'pr-state-gate': { label: 'PR state gate', hint: 'Fails on draft, conflicts, missing approval or a stale branch' },
  merge: { label: 'Merge the PR', hint: 'Squash-merges and optionally deletes the branch. Irreversible' },
  'pr-action': { label: 'PR action', hint: 'Runs one of the PR actions — pair it with a condition' },
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
    case 'executable':
      return {
        ...base,
        kind,
        config: { command: '', workdir: 'clone', timeoutMs: 10 * 60_000, variables: [] },
      };
    case 'npm-bootstrap':
      // Defaults match what a Changesets repo prints; dryRun starts on so the
      // first run of a newly added step cannot publish anything.
      return {
        ...base,
        kind,
        config: {
          detectCommand: 'pnpm release:preflight',
          sectionPattern: '^### Require bootstrap$',
          packagePattern: '^\\s*-\\s*`([^`]+)`',
          countPattern: '^- Require bootstrap: (\\d+)$',
          token: { name: 'NPM_TOKEN', hidden: true },
          workflowFile: 'publish.yml',
          dryRun: true,
          timeoutMs: 20 * 60_000,
        },
      };
    case 'pr-state-gate':
      return { ...base, kind, config: { requireReady: true, requireApproved: true, requireUpToDate: true } };
    case 'merge':
      return { ...base, kind, config: { method: 'squash', deleteBranch: true, requirePinnedHead: true } };
    case 'pr-action':
      // Confirmation on by default: an action step exists to do something to
      // someone's pull request, usually as a reaction to a gate.
      return { ...base, kind, requiresApproval: true, config: { action: 'pr.resolve-conflicts' } };
  }
}

export function PipelinesPage(): JSX.Element {
  const { current, pipelines, runs, stepDefs, loaded, definitionsFailed, error, setError, refresh } = usePipelines();
  // A skeleton that appears and vanishes inside a blink reads as a glitch.
  const settling = useSettledFlag(!loaded);
  const { can } = useAuth();
  const [editing, setEditing] = useState<PipelineRecord | 'new' | null>(null);
  const [editingDef, setEditingDef] = useState<StepDefinitionRecord | 'new' | null>(null);
  const [generating, setGenerating] = useState(false);
  const [importing, setImporting] = useState<{ text: string; fileName?: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const { confirmDanger, confirmElement } = useConfirm();
  const canManage = can('pipelines:manage');
  const canUseAgents = can('runs:read') && can('runs:act');

  const removePipeline = async (pipeline: PipelineRecord): Promise<void> => {
    const ok = await confirmDanger({
      title: `Delete pipeline ${pipeline.name}`,
      message: `"${pipeline.name}" stops running against new targets. Its run history is kept.`,
    });
    if (ok) await api.deletePipeline(pipeline.id).then(refresh).catch((e) => setError(String(e)));
  };

  const removeStepDefinition = async (definition: StepDefinitionRecord): Promise<void> => {
    const ok = await confirmDanger({
      title: `Delete step ${definition.name}`,
      message: `Pipelines referencing "${definition.name}" will fail to resolve it until they are edited.`,
    });
    if (ok) await api.deleteStepDefinition(definition.id).then(refresh).catch((e) => setError(String(e)));
  };

  if (!current) return <EmptyState title="No workspace selected" />;

  return (
    <Page>
      <PageHeader
        title="Pipelines"
        subtitle={`${current.name} — controllable PR, issue and repository workflows with durable progress`}
        actions={
          canManage ? (
            <>
              <ActionMenu
                trigger="Options"
                label="Other ways to create a pipeline"
                actions={[
                  ...(canUseAgents
                    ? [{ label: 'Generate with AI…', onSelect: () => setGenerating(true) }]
                    : []),
                  { label: 'Import from file…', onSelect: () => fileInput.current?.click() },
                  { label: 'Import pasted JSON…', onSelect: () => setImporting({ text: '' }) },
                ]}
              />
              <button className="btn" onClick={() => setEditing('new')}>
                New pipeline
              </button>
            </>
          ) : undefined
        }
      />
      <ErrorBar error={error} />
      {error ? (
        <div className="mb-3">
          <button type="button" className="btn-ghost text-xs" onClick={() => void refresh()}>
            Retry pipeline data
          </button>
        </div>
      ) : null}
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Reset first: picking the same file again after fixing it must still fire.
          e.target.value = '';
          if (file) void file.text().then((text) => setImporting({ text, fileName: file.name }));
        }}
      />

      <div className="flex flex-col gap-3">
        {settling ? (
          <div className="card">
            <RowsSkeleton rows={2} />
          </div>
        ) : null}
        {pipelines.map((p, i) => (
          <article key={p.id} style={rowDelay(i, 6)} className="card card-in" aria-label={p.name}>
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="dim text-[10px] font-medium tracking-widest uppercase">{TYPE_META[p.type].label}</div>
                <h2 className="mt-1 truncate text-base font-semibold">{p.name}</h2>
                <p className="dim mt-1 line-clamp-2 text-[13px]">
                  {p.description || TYPE_META[p.type].hint}
                </p>
              </div>
              <div className="flex flex-wrap justify-end gap-1.5">
                {p.autoRunOnPrOpen ? (
                  <span className="badge-accent shrink-0">
                    auto-run on {p.type === 'issue' ? 'issue' : 'PR'} open
                  </span>
                ) : null}
                {p.autoRunOnPrUpdate ? <span className="badge shrink-0">re-run on new commits</span> : null}
              </div>
            </div>
            <ol className="mt-4 flex items-center overflow-x-auto pb-1" aria-label={`${p.name} steps`}>
              {p.steps.map((spec, i) => {
                const label =
                  spec.type === 'inline'
                    ? spec.step.name
                    : (spec.overrides?.name ??
                      stepDefs.find((d) => d.id === spec.stepDefinitionId)?.name ??
                      'missing step');
                const isRef = spec.type === 'ref';
                return (
                  <li key={i} className="flex shrink-0 items-center">
                    {i > 0 ? (
                      <span className="mx-1.5 flex w-5 items-center" aria-hidden>
                        <span className="h-px flex-1 bg-zinc-300 dark:bg-zinc-700" />
                        <span className="dim -ml-0.5 text-xs">›</span>
                      </span>
                    ) : null}
                    <span
                      className={`inline-flex h-8 items-center gap-2 rounded-lg border px-2.5 text-xs ${
                        isRef
                          ? 'border-accent-300 bg-accent-50 text-accent-800 dark:border-accent-700 dark:bg-accent-950/30 dark:text-accent-300'
                          : 'border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900'
                      }`}
                      title={isRef ? 'Shared step from the library' : undefined}
                    >
                      <span className="dim font-mono text-[10px] tabular-nums">{i + 1}</span>
                      <span className="max-w-56 truncate">{label}</span>
                    </span>
                  </li>
                );
              })}
            </ol>
            {canManage ? (
              <CardActions>
                <span className="dim mr-auto text-xs">
                  {p.steps.length} {p.steps.length === 1 ? 'step' : 'steps'}
                </span>
                {p.type === 'platform' && can('pipelines:run') ? <PlatformRunButton pipeline={p} onError={setError} /> : null}
                <button className="btn-ghost" onClick={() => setEditing(p)}>Edit</button>
                <ActionMenu
                  trigger="Actions"
                  label={`Actions for ${p.name}`}
                  actions={[
                    { label: 'Export JSON', onSelect: () => void exportPipeline(p, setError) },
                    { label: 'Delete pipeline', danger: true, onSelect: () => void removePipeline(p) },
                  ]}
                />
              </CardActions>
            ) : null}
          </article>
        ))}
      </div>
      {loaded && !definitionsFailed && pipelines.length === 0 ? (
        <EmptyState
          title="No pipelines yet"
          hint="A pipeline is an ordered set of steps — CI gate, AI review, custom agents, labels, comments — that you run against pull requests."
        />
      ) : null}

      {runs.length > 0 ? (
        <Section
          title="Recent runs"
          description="Open a run to inspect each step, replay command output after a refresh, or stop work that is no longer useful."
        >
          <PipelineRunList runs={runs} title="Run history" showTarget />
        </Section>
      ) : null}

      <Section
        title="Custom step library"
        description="Reusable steps shared by every pipeline in this workspace. Editing a library step updates all pipelines that reference it."
      >
        {/* Creating a library step belongs beside the library, not in a header
            row of four equal buttons where the primary action stopped reading
            as primary. */}
        {canManage && stepDefs.length > 0 ? (
          <div className="mb-3">
            <button className="btn-ghost" onClick={() => setEditingDef('new')}>
              New custom step
            </button>
          </div>
        ) : null}
        {settling ? (
          <div className="card">
            <RowsSkeleton rows={2} />
          </div>
        ) : null}
        {loaded && !definitionsFailed && stepDefs.length === 0 ? (
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
            {stepDefs.map((d, i) => (
              <article key={d.id} style={rowDelay(i, 6)} className="card card-in" aria-label={d.name}>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{d.name}</div>
                  <div className="dim mt-0.5 text-xs">{KIND_META[d.step.kind].label}</div>
                </div>
                {d.description ? <p className="dim mt-2 line-clamp-2 text-[13px]">{d.description}</p> : null}
                {canManage ? (
                  <CardActions>
                    <button className="btn-ghost" onClick={() => setEditingDef(d)}>Edit</button>
                    <ActionMenu
                      trigger="Actions"
                      label={`Actions for ${d.name}`}
                      actions={[{ label: 'Delete custom step', danger: true, onSelect: () => void removeStepDefinition(d) }]}
                    />
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
      {importing ? (
        <ImportModal
          workspaceId={current.id}
          initialText={importing.text}
          fileName={importing.fileName}
          onClose={() => setImporting(null)}
          onImported={() => {
            setImporting(null);
            void refresh();
          }}
        />
      ) : null}
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
      <button className="btn" disabled={busy || !repo} onClick={() => void run()}>
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
  const [autoUpdate, setAutoUpdate] = useState(pipeline?.autoRunOnPrUpdate ?? false);
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
        autoRunOnPrUpdate: type === 'pr' ? autoUpdate : false,
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
  const unsafeAutoRun =
    (autoRun || autoUpdate) &&
    steps.some((spec) => {
      const kind =
        spec.type === 'inline'
          ? spec.step.kind
          : stepDefs.find((definition) => definition.id === spec.stepDefinitionId)?.step.kind;
      return kind === 'executable' || kind === 'npm-bootstrap';
    });

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
              if (next !== 'pr') setAutoUpdate(false);
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
        {type === 'pr' ? (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={autoUpdate} onChange={(e) => setAutoUpdate(e.target.checked)} />
            Re-run automatically when a PR receives a new head commit
          </label>
        ) : null}
        {unsafeAutoRun ? (
          <div className="banner-warn mb-0 text-xs">
            Command and publishing steps can run only when a person starts the pipeline. Turn off webhook auto-run or
            remove the privileged step.
          </div>
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
                  <StepForm
                    workspaceId={workspaceId}
                    step={spec.step}
                    onChange={(step) => updateStep(i, { type: 'inline', step })}
                  />
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
          <button className="btn" disabled={busy || !valid || unsafeAutoRun} onClick={() => void save()}>
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

function StepForm({
  workspaceId,
  step,
  onChange,
}: {
  workspaceId: string;
  step: PipelineStep;
  onChange: (s: PipelineStep) => void;
}): JSX.Element {
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
      <StepConfigForm workspaceId={workspaceId} step={step} onChange={onChange} />
    </div>
  );
}

function StepConfigForm({
  workspaceId,
  step,
  onChange,
}: {
  workspaceId: string;
  step: PipelineStep;
  onChange: (s: PipelineStep) => void;
}): JSX.Element {
  switch (step.kind) {
    case 'checks-gate':
      return (
        <div className="flex flex-col gap-2 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={step.config.allowPending}
              onChange={(e) => onChange({ ...step, config: { ...step.config, allowPending: e.target.checked } })}
            />
            Pass while checks are still running (only fail on red)
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={step.config.requireProtectedContexts ?? false}
              onChange={(e) =>
                onChange({ ...step, config: { ...step.config, requireProtectedContexts: e.target.checked } })
              }
            />
            Also verify every required context by name (catches a missing or wholly skipped suite)
          </label>
        </div>
      );
    case 'pr-state-gate':
      return (
        <div className="flex flex-col gap-2 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={step.config.requireReady}
              onChange={(e) => onChange({ ...step, config: { ...step.config, requireReady: e.target.checked } })}
            />
            Fail while the PR is a draft
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={step.config.requireApproved}
              onChange={(e) => onChange({ ...step, config: { ...step.config, requireApproved: e.target.checked } })}
            />
            Require a human approval on GitHub
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={step.config.requireUpToDate}
              onChange={(e) => onChange({ ...step, config: { ...step.config, requireUpToDate: e.target.checked } })}
            />
            Fail when behind a base that requires up-to-date branches
          </label>
        </div>
      );
    case 'pr-action':
      return (
        <Field label="Action to perform on the pull request">
          <select
            className="input"
            value={step.config.action}
            onChange={(e) => onChange({ ...step, config: { action: e.target.value as PrActionId } })}
          >
            <option value="pr.resolve-conflicts">Resolve conflicts with an agent</option>
            <option value="pr.address-reviews">Address review feedback with an agent</option>
            <option value="pr.fix-checks">Repair failing checks with an agent</option>
            <option value="pr.analyze-checks">Investigate failures with AI</option>
            <option value="pr.rerun-failed">Re-run failed jobs</option>
            <option value="pr.rerun-all">Re-run all jobs</option>
            <option value="pr.update-branch">Update branch from base</option>
            <option value="pr.mark-ready">Mark ready for review</option>
          </select>
        </Field>
      );
    case 'merge':
      return (
        <div className="flex flex-col gap-2 text-sm">
          <div className="rounded border border-red-500/40 bg-red-500/10 p-2 text-xs">
            Merging is irreversible. Every gate above this step decides whether it runs.
          </div>
          <Field label="Method">
            <select
              className="input"
              value={step.config.method}
              onChange={(e) =>
                onChange({
                  ...step,
                  config: { ...step.config, method: e.target.value as 'merge' | 'squash' | 'rebase' },
                })
              }
            >
              <option value="squash">Squash</option>
              <option value="merge">Merge commit</option>
              <option value="rebase">Rebase</option>
            </select>
          </Field>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={step.config.deleteBranch}
              onChange={(e) => onChange({ ...step, config: { ...step.config, deleteBranch: e.target.checked } })}
            />
            Delete the head branch after merging
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={step.config.requirePinnedHead}
              onChange={(e) => onChange({ ...step, config: { ...step.config, requirePinnedHead: e.target.checked } })}
            />
            Refuse if the head moved during this run (recommended)
          </label>
        </div>
      );
    case 'ai-review':
      return (
        <div className="flex flex-col gap-3 text-sm">
          <Field label="Review provider">
            <ReviewProviderSelect
              scope={{ kind: 'workspace', workspaceId }}
              sharedOnly
              value={step.config.provider ? encodeIntegrationTarget(step.config.provider) : ''}
              onChange={(_value, provider) => {
                if (provider) {
                  onChange({ ...step, config: { ...step.config, provider } });
                  return;
                }
                const config = { ...step.config };
                delete config.provider;
                onChange({ ...step, config });
              }}
            />
            <span className="dim mt-1 block text-xs">
              Repository route resolves primary and fallback when the pipeline runs. Delegated providers can be
              informational only because their verdict arrives outside Companion.
            </span>
          </Field>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={step.config.post}
                onChange={(e) => onChange({ ...step, config: { ...step.config, post: e.target.checked } })}
              />
              Publish findings and the final verdict to GitHub
            </label>
            <label className="flex items-center gap-2">
              <span className="dim">Fail when</span>
              <select
                className="input input-sm"
                value={step.config.failOn}
                onChange={(e) =>
                  onChange({
                    ...step,
                    config: {
                      ...step.config,
                      failOn: e.target.value as 'request_changes' | 'high_risk' | 'blocker' | 'never',
                    },
                  })
                }
              >
                <option value="high_risk">risk is high</option>
                <option value="request_changes">changes are requested</option>
                <option value="blocker">a confirmed blocker is found</option>
                <option value="never">never (informational)</option>
              </select>
            </label>
          </div>
          {step.config.post ? (
            <p className="dim text-xs">
              On large pull requests, ready inline findings are published as each review group finishes. Serious or
              uncertain claims wait for verification; one final verdict follows after complete coverage.
            </p>
          ) : null}
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
    case 'executable':
      return <ExecutableConfigForm step={step} onChange={onChange} />;
    case 'npm-bootstrap':
      return <NpmBootstrapConfigForm step={step} onChange={onChange} />;
  }
}

function NpmBootstrapConfigForm({
  step,
  onChange,
}: {
  step: Extract<PipelineStep, { kind: 'npm-bootstrap' }>;
  onChange: (s: PipelineStep) => void;
}): JSX.Element {
  const cfg = step.config;
  const set = (patch: Partial<typeof cfg>): void => onChange({ ...step, config: { ...cfg, ...patch } });
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded border border-red-500/40 bg-red-500/10 p-2 text-xs">
        Publishing to npm is irreversible: versions are immutable. Detection runs without the token; the
        token is resolved only once a package actually needs publishing, and the publish uses
        <code> --ignore-scripts</code>.
      </div>
      <Field label="Detection command (must print the packages the registry is missing)">
        <input className="input font-mono text-xs" value={cfg.detectCommand} onChange={(e) => set({ detectCommand: e.target.value })} />
      </Field>
      <div className="flex flex-wrap gap-4">
        <Field label="Section heading pattern (scopes the search)">
          <input
            className="input font-mono text-xs"
            value={cfg.sectionPattern ?? ''}
            onChange={(e) => set({ sectionPattern: e.target.value || undefined })}
          />
        </Field>
        <Field label="Package pattern (group 1 = one package spec)">
          <input className="input font-mono text-xs" value={cfg.packagePattern} onChange={(e) => set({ packagePattern: e.target.value })} />
        </Field>
        <Field label="Count pattern (group 1 = how many it says)">
          <input className="input font-mono text-xs" value={cfg.countPattern} onChange={(e) => set({ countPattern: e.target.value })} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-4">
        <Field label="Workflow filename">
          <input className="input" value={cfg.workflowFile} onChange={(e) => set({ workflowFile: e.target.value })} />
        </Field>
        <Field label="Timeout (minutes)">
          <input
            type="number"
            className="input w-24"
            min={1}
            max={60}
            value={Math.round(cfg.timeoutMs / 60_000)}
            onChange={(e) => set({ timeoutMs: Math.min(60, Math.max(1, Number(e.target.value) || 1)) * 60_000 })}
          />
        </Field>
      </div>
      <VariablesEditor
        variables={[cfg.token]}
        onChange={(v) => set({ token: { ...(v[0] ?? cfg.token), hidden: true } })}
        label="npm token — hidden, owned by whoever supplies it"
        fixedHidden
      />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={cfg.dryRun} onChange={(e) => set({ dryRun: e.target.checked })} />
        Dry run — detect and verify, publish nothing
      </label>
    </div>
  );
}

/** Download the portable document as a file the user can hand to someone else. */
async function exportPipeline(p: PipelineRecord, onError: (e: string) => void): Promise<void> {
  try {
    const { document: doc } = await api.exportPipeline(p.id);
    const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }));
    const a = window.document.createElement('a');
    a.href = url;
    a.download = `${p.name.replace(/[^\w.-]+/g, '-').toLowerCase()}.pipeline.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    onError(String(e));
  }
}

/**
 * Two-phase import: preview first, then confirm. The preview exists so the
 * command-running steps are read before anything is written, not to block them.
 */
function ImportModal({
  workspaceId,
  initialText,
  fileName,
  onClose,
  onImported,
}: {
  workspaceId: string;
  /** Already filled when a file was chosen; empty for the paste route. */
  initialText: string;
  fileName?: string;
  onClose: () => void;
  onImported: () => void;
}): JSX.Element {
  const [text, setText] = useState(initialText);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = (): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('that is not valid JSON — paste the whole exported document, or choose the .json file');
    }
  };

  const doPreview = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const { preview: p } = await api.previewPipelineImport(workspaceId, parsed());
      setPreview(p);
      setAcknowledged(p.executables.length === 0);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // A chosen file needs no second click to be read: the choice WAS the input.
  // Declared after doPreview so it reads top-down, though the effect body only
  // runs once the whole component function has finished either way.
  useEffect(() => {
    if (initialText.trim()) void doPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doImport = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.importPipeline(workspaceId, parsed(), acknowledged);
      onImported();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <Modal title="Import pipeline" onClose={onClose}>
      <ErrorBar error={error} />
      {!preview ? (
        <>
          {fileName ? (
            <p className="dim text-sm">
              Reading <span className="font-mono">{fileName}</span>.
            </p>
          ) : (
            <Field label="Paste an exported pipeline document">
              {/* Short by default: a tall empty box reads as a void, and the
                  document is pasted in one go rather than typed. */}
              <textarea
                className="input min-h-24 font-mono text-xs"
                value={text}
                placeholder={'{ "version": 1, "pipeline": { … } }'}
                autoFocus
                onChange={(e) => setText(e.target.value)}
              />
              <p className="dim mt-1.5 text-xs">
                Produced by <strong>Export</strong> on a pipeline card, here or on another instance. Hidden
                variables travel as names only, so you will be asked for their values after importing.
              </p>
            </Field>
          )}
          <FormActions>
            <button className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn" disabled={busy || !text.trim()} onClick={() => void doPreview()}>
              {busy ? 'Reading…' : 'Review'}
            </button>
          </FormActions>
        </>
      ) : (
        <>
          <div className="flex flex-col gap-1 text-sm">
            <div className="font-medium">{preview.name}</div>
            <p className="dim text-xs">
              {TYPE_META[preview.type].label} · {preview.stepCount} step{preview.stepCount === 1 ? '' : 's'}
              {preview.description ? ` · ${preview.description}` : ''}
            </p>
          </div>

          {preview.executables.length > 0 ? (
            <Section title={`${preview.executables.length} step(s) run commands on this machine`}>
              <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
                Importing only creates the definition. Running it still needs the
                <code> pipelines:execute</code> permission and the instance switch. Read the commands anyway.
              </div>
              <ul className="mt-2 flex flex-col gap-2">
                {preview.executables.map((e, i) => (
                  <li key={i} className="rounded border border-[var(--border)] p-2">
                    <div className="text-xs font-medium">
                      {e.name} <span className="dim">({e.kind})</span>
                    </div>
                    <pre className="mt-1 overflow-x-auto text-xs">{e.command}</pre>
                    {e.secretKeys.length > 0 ? (
                      <p className="dim mt-1 text-xs">reads secrets: {e.secretKeys.join(', ')}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
              <label className="mt-2 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
                I have read these commands
              </label>
            </Section>
          ) : null}

          {preview.requiredSecrets.length > 0 ? (
            <p className="dim mt-2 text-xs">
              Expects these secrets to be configured on this instance: {preview.requiredSecrets.join(', ')}
            </p>
          ) : null}

          <FormActions>
            <button className="btn-ghost" onClick={() => setPreview(null)}>
              Back
            </button>
            <button className="btn" disabled={busy || !acknowledged} onClick={() => void doImport()}>
              {busy ? 'Importing…' : 'Import'}
            </button>
          </FormActions>
        </>
      )}
    </Modal>
  );
}

/**
 * The step's environment as one list. Ticking "hidden" moves the value out of
 * the pipeline definition into the secret store, which is why a hidden row's
 * value is never rendered back: the server does not have it to send.
 */
function VariablesEditor({
  variables,
  onChange,
  label = 'Variables — these become environment variables for the command',
  fixedHidden = false,
}: {
  variables: readonly StepVariable[];
  onChange: (v: StepVariable[]) => void;
  label?: string;
  /** The slot exists to carry a credential, so hidden is not a choice here. */
  fixedHidden?: boolean;
}): JSX.Element {
  const patch = (i: number, next: Partial<StepVariable>): void =>
    onChange(variables.map((v, j) => (i === j ? { ...v, ...next } : v)));

  return (
    <Field label={label}>
      <div className="flex flex-col gap-1.5">
        {variables.map((v, i) => {
          // A hidden row that already has a key holds a value we cannot read
          // back, so an empty input means "leave it alone", not "clear it".
          const stored = v.hidden && Boolean(v.secretKey);
          return (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <input
                className="input w-44 font-mono text-xs"
                aria-label={`Variable ${i + 1} name`}
                value={v.name}
                placeholder="NPM_TOKEN"
                onChange={(e) => patch(i, { name: e.target.value.trim() })}
              />
              <input
                className="input min-w-0 flex-1 font-mono text-xs"
                aria-label={`Variable ${i + 1} value`}
                type={v.hidden ? 'password' : 'text'}
                value={v.value ?? ''}
                placeholder={stored ? '•••••••• stored — type to replace' : v.hidden ? 'value' : '{{steps.…}} or a literal'}
                onChange={(e) => patch(i, { value: e.target.value })}
              />
              {fixedHidden ? null : (
                <label className="flex shrink-0 items-center gap-1 text-xs" title="Store in the secret vault instead of the pipeline definition">
                  <input
                    type="checkbox"
                    checked={v.hidden}
                    onChange={(e) => patch(i, { hidden: e.target.checked, value: '' })}
                  />
                  hidden
                </label>
              )}
              {v.hidden ? (
                <select
                  className="input input-sm w-28 shrink-0"
                  aria-label={`Variable ${i + 1} visibility`}
                  value={v.visibility ?? 'private'}
                  onChange={(e) => patch(i, { visibility: e.target.value as 'private' | 'shared' })}
                >
                  <option value="private">only me</option>
                  <option value="shared">workspace</option>
                </select>
              ) : null}
              {v.ownerId ? <span className="dim shrink-0 text-xs">{v.ownerId}</span> : null}
              {fixedHidden ? null : (
                <button
                  type="button"
                  className="btn-ghost shrink-0"
                  aria-label={`Remove variable ${i + 1}`}
                  onClick={() => onChange(variables.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              )}
            </div>
          );
        })}
        {fixedHidden ? null : (
          <div>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => onChange([...variables, { name: '', hidden: false, value: '' }])}
            >
              + Add variable
            </button>
          </div>
        )}
        <p className="dim text-xs">
          Visible values are stored with the pipeline and travel in an export. Hidden values go to the secret
          store owned by whoever set them, are never exported, and are redacted from output and the audit
          trail. "only me" means a run started by anyone else cannot use the value.
        </p>
      </div>
    </Field>
  );
}

function ExecutableConfigForm({
  step,
  onChange,
}: {
  step: Extract<PipelineStep, { kind: 'executable' }>;
  onChange: (s: PipelineStep) => void;
}): JSX.Element {
  const cfg = step.config;
  const set = (patch: Partial<typeof cfg>): void => onChange({ ...step, config: { ...cfg, ...patch } });
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
        This runs as the daemon user with no sandbox. It only runs when an admin has enabled executable
        steps for this instance <em>and</em> the person starting the run holds <code>pipelines:execute</code>.
        Webhook auto-runs never execute it.
      </div>
      <Field label="Command (supports the same {{…}} placeholders as comments)">
        <textarea
          className="input min-h-20 font-mono text-xs"
          value={cfg.command}
          placeholder="pnpm release:preflight"
          onChange={(e) => set({ command: e.target.value })}
        />
      </Field>
      <div className="flex flex-wrap gap-4">
        <Field label="Working directory">
          <select
            className="input"
            value={cfg.workdir}
            onChange={(e) => set({ workdir: e.target.value as 'pr-worktree' | 'clone' })}
          >
            <option value="clone">Repo clone</option>
            <option value="pr-worktree">PR worktree (needs a PR target)</option>
          </select>
        </Field>
        <Field label="Timeout (minutes)">
          <input
            type="number"
            className="input w-24"
            min={1}
            max={60}
            value={Math.round(cfg.timeoutMs / 60_000)}
            onChange={(e) => set({ timeoutMs: Math.min(60, Math.max(1, Number(e.target.value) || 1)) * 60_000 })}
          />
        </Field>
      </div>
      <VariablesEditor variables={cfg.variables} onChange={(variables) => set({ variables })} />
    </div>
  );
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

        <StepForm workspaceId={workspaceId} step={step} onChange={setStep} />

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
