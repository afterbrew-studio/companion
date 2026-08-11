import { useState } from 'react';
import type { RepoRecord } from '@companion/module-code/contract';
import { Checkbox, ErrorBar, Field, FormActions, Modal, Spinner } from '@moxxy/companion-sdk/ui';
import type {
  PlaygroundEvaluationCaseInput,
  PlaygroundEvaluationCaseRecord,
  PlaygroundJsonPrimitive,
} from '../../contract/index.js';
import { playgroundApi } from '../api.js';

const TIMEOUTS = [
  { ms: 60_000, label: '1 minute' },
  { ms: 180_000, label: '3 minutes' },
  { ms: 300_000, label: '5 minutes' },
  { ms: 600_000, label: '10 minutes' },
] as const;

interface CaseFormState {
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  readonly repo: string;
  readonly skill: string;
  readonly timeoutMs: number;
  readonly tags: string;
  readonly safetyCritical: boolean;
  readonly responseFormat: 'text' | 'json';
  readonly requiredPhrases: string;
  readonly forbiddenPhrases: string;
  readonly requiredJsonPaths: string;
  readonly expectedJson: string;
  readonly maxDurationMs: string;
  readonly maxInputTokens: string;
  readonly maxOutputTokens: string;
}

const EMPTY_FORM: CaseFormState = {
  name: '',
  description: '',
  prompt: '',
  repo: '',
  skill: '',
  timeoutMs: 180_000,
  tags: '',
  safetyCritical: false,
  responseFormat: 'text',
  requiredPhrases: '',
  forbiddenPhrases: '',
  requiredJsonPaths: '',
  expectedJson: '{}',
  maxDurationMs: '',
  maxInputTokens: '',
  maxOutputTokens: '',
};

export function EvaluationCaseEditor({
  record,
  repos,
  skills,
  onClose,
  onSaved,
}: {
  readonly record: PlaygroundEvaluationCaseRecord | null;
  readonly repos: ReadonlyArray<RepoRecord>;
  readonly skills: ReadonlyArray<string>;
  readonly onClose: () => void;
  readonly onSaved: () => Promise<void>;
}): React.JSX.Element {
  const [form, setForm] = useState<CaseFormState>(() => record ? formFromRecord(record) : EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof CaseFormState>(key: K, value: CaseFormState[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const save = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const input = formToInput(form);
      if (record) await playgroundApi.updateEvaluationCase(record.id, record.revision, input);
      else await playgroundApi.createEvaluationCase(input);
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={record ? `Edit evaluation — ${record.name}` : 'New regression case'} onClose={onClose} wide>
      <form onSubmit={(event) => void save(event)}>
        <ErrorBar error={error} className="mb-3" />
        <div className="rounded-lg border border-blue-500/25 bg-blue-500/5 p-3 text-xs leading-relaxed">
          Write a stable input, then define evidence that must appear and claims that must not. For classifications,
          use JSON and pin fields such as <code className="code-inline">qualityClass</code> to an exact or allowed value.
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label="Case name">
            <input
              className="input"
              required
              minLength={3}
              maxLength={100}
              value={form.name}
              onChange={(event) => set('name', event.target.value)}
              autoFocus
            />
          </Field>
          <Field label="Tags" hint="Comma-separated: prompt-injection, oversized, security…">
            <input className="input" value={form.tags} onChange={(event) => set('tags', event.target.value)} />
          </Field>
        </div>
        <Field label="Purpose" hint="Explain the regression this case protects against." className="mt-3">
          <input
            className="input"
            maxLength={1_000}
            value={form.description}
            onChange={(event) => set('description', event.target.value)}
          />
        </Field>
        <Field
          label="Test input"
          hint="Fixtures and repository content are untrusted; the server always adds a read-only fence."
          className="mt-3"
        >
          <textarea
            className="input min-h-40 resize-y font-mono text-xs leading-relaxed"
            required
            minLength={4}
            maxLength={64_000}
            value={form.prompt}
            onChange={(event) => set('prompt', event.target.value)}
          />
        </Field>

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field label="Repository">
            <select className="input" value={form.repo} onChange={(event) => set('repo', event.target.value)}>
              <option value="">Private scratch case</option>
              {repos.map((repo) => (
                <option key={repo.fullName} value={repo.fullName} disabled={!repo.cloneReady}>
                  {repo.fullName}{repo.cloneReady ? '' : ' (no clone)'}
                </option>
              ))}
              {record?.repo && !repos.some((repo) => repo.fullName === record.repo)
                ? <option value={record.repo}>{record.repo}</option>
                : null}
            </select>
          </Field>
          <Field label="Skill">
            <select className="input" value={form.skill} onChange={(event) => set('skill', event.target.value)}>
              <option value="">No preloaded skill</option>
              {skills.map((skill) => <option key={skill} value={skill}>{skill}</option>)}
              {record?.skill && !skills.includes(record.skill)
                ? <option value={record.skill}>{record.skill}</option>
                : null}
            </select>
          </Field>
          <Field label="Hard time limit">
            <select
              className="input"
              value={form.timeoutMs}
              onChange={(event) => set('timeoutMs', Number(event.target.value))}
            >
              {TIMEOUTS.map((timeout) => <option key={timeout.ms} value={timeout.ms}>{timeout.label}</option>)}
            </select>
          </Field>
        </div>

        <div className="mt-5 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <h3 className="text-xs font-semibold tracking-wide uppercase">Pass criteria</h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="Response format">
              <select
                className="input"
                value={form.responseFormat}
                onChange={(event) => set('responseFormat', event.target.value as 'text' | 'json')}
              >
                <option value="text">Markdown / text</option>
                <option value="json">JSON object</option>
              </select>
            </Field>
            <label className="flex items-center gap-2 self-end rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
              <Checkbox
                checked={form.safetyCritical}
                onToggle={() => set('safetyCritical', !form.safetyCritical)}
                label="Safety-critical rollout blocker"
              />
              <span>
                <span className="font-medium">Safety-critical</span>
                <span className="dim ml-1 text-xs">failed replay blocks rollout</span>
              </span>
            </label>
            <Field label="Must mention" hint="One case-insensitive phrase per line.">
              <textarea
                className="input min-h-24 resize-y text-xs"
                value={form.requiredPhrases}
                onChange={(event) => set('requiredPhrases', event.target.value)}
              />
            </Field>
            <Field label="Must not claim" hint="Unsupported facts, unsafe actions or misleading certainty.">
              <textarea
                className="input min-h-24 resize-y text-xs"
                value={form.forbiddenPhrases}
                onChange={(event) => set('forbiddenPhrases', event.target.value)}
              />
            </Field>
          </div>
          {form.responseFormat === 'json' ? (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="Required JSON paths" hint="One dot path per line, e.g. findings.0.severity">
                <textarea
                  className="input min-h-24 resize-y font-mono text-xs"
                  value={form.requiredJsonPaths}
                  onChange={(event) => set('requiredJsonPaths', event.target.value)}
                />
              </Field>
              <Field
                label="Expected JSON values"
                hint={'JSON object: {"qualityClass":["valuable","promising"],"safe":true}'}
              >
                <textarea
                  className="input min-h-24 resize-y font-mono text-xs"
                  value={form.expectedJson}
                  onChange={(event) => set('expectedJson', event.target.value)}
                />
              </Field>
            </div>
          ) : null}
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Field label="Max wall time (ms)" hint="Blank = no latency gate">
              <input className="input" type="number" min={1_000} max={600_000} value={form.maxDurationMs} onChange={(event) => set('maxDurationMs', event.target.value)} />
            </Field>
            <Field label="Max input tokens" hint="Unavailable usage fails closed">
              <input className="input" type="number" min={1} max={2_000_000} value={form.maxInputTokens} onChange={(event) => set('maxInputTokens', event.target.value)} />
            </Field>
            <Field label="Max output tokens" hint="Unavailable usage fails closed">
              <input className="input" type="number" min={1} max={500_000} value={form.maxOutputTokens} onChange={(event) => set('maxOutputTokens', event.target.value)} />
            </Field>
          </div>
        </div>

        <FormActions divider>
          <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? <><Spinner /> Saving…</> : record ? 'Save new revision' : 'Save case'}
          </button>
        </FormActions>
      </form>
    </Modal>
  );
}

function formFromRecord(record: PlaygroundEvaluationCaseRecord): CaseFormState {
  return {
    name: record.name,
    description: record.description,
    prompt: record.prompt,
    repo: record.repo ?? '',
    skill: record.skill ?? '',
    timeoutMs: record.timeoutMs,
    tags: record.tags.join(', '),
    safetyCritical: record.safetyCritical,
    responseFormat: record.expectation.responseFormat,
    requiredPhrases: record.expectation.requiredPhrases.join('\n'),
    forbiddenPhrases: record.expectation.forbiddenPhrases.join('\n'),
    requiredJsonPaths: record.expectation.requiredJsonPaths.join('\n'),
    expectedJson: JSON.stringify(record.expectation.expectedJson, null, 2),
    maxDurationMs: record.expectation.maxDurationMs?.toString() ?? '',
    maxInputTokens: record.expectation.maxInputTokens?.toString() ?? '',
    maxOutputTokens: record.expectation.maxOutputTokens?.toString() ?? '',
  };
}

function formToInput(form: CaseFormState): PlaygroundEvaluationCaseInput {
  let expectedJson: Record<string, PlaygroundJsonPrimitive | ReadonlyArray<PlaygroundJsonPrimitive>> = {};
  if (form.responseFormat === 'json') {
    const parsed = JSON.parse(form.expectedJson.trim() || '{}') as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Expected JSON values must be a JSON object keyed by dot path.');
    }
    expectedJson = parsed as typeof expectedJson;
  }
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    prompt: form.prompt.trim(),
    repo: form.repo || null,
    skill: form.skill || null,
    timeoutMs: form.timeoutMs,
    tags: form.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
    safetyCritical: form.safetyCritical,
    expectation: {
      responseFormat: form.responseFormat,
      requiredPhrases: lines(form.requiredPhrases),
      forbiddenPhrases: lines(form.forbiddenPhrases),
      requiredJsonPaths: form.responseFormat === 'json' ? lines(form.requiredJsonPaths) : [],
      expectedJson,
      maxDurationMs: optionalNumber(form.maxDurationMs),
      maxInputTokens: optionalNumber(form.maxInputTokens),
      maxOutputTokens: optionalNumber(form.maxOutputTokens),
    },
  };
}

function lines(value: string): string[] {
  return value.split('\n').map((line) => line.trim()).filter(Boolean);
}

function optionalNumber(value: string): number | null {
  return value.trim() ? Number(value) : null;
}
