import { useEffect, useState } from 'react';
import type { RouteProps } from '@companion/core/client';
import { useKernel } from '@companion/core/client';
import { useAuth } from '@companion/module-core/client';
import { codeApi } from '@companion/module-code/client';
import { operateApi } from '@companion/module-operate/client';
import type { RepoRecord } from '@companion/module-code/contract';
import {
  ErrorBar,
  Field,
  Markdown,
  Page,
  PageHeader,
  SparkleIcon,
  Spinner,
  aiAccentClass,
} from '@companion/ui';
import type { PlaygroundRunResult } from '../../contract/index.js';
import { playgroundApi } from '../api.js';

/**
 * The agent test bench: compose a one-shot prompt, optionally against a
 * connected repo's clone and with a skill preloaded, and see what the agent
 * WOULD do — every run is fenced read-only by the server-side prompt.
 * `#/playground?skill=<name>` (the Skills page's dry-run button) preselects
 * the skill.
 */

const TIMEOUTS = [
  { ms: 60_000, label: '1 min' },
  { ms: 180_000, label: '3 min' },
  { ms: 300_000, label: '5 min' },
  { ms: 600_000, label: '10 min' },
] as const;

export function AgentLabPage({ query }: RouteProps): JSX.Element {
  const kernel = useKernel();
  const { can } = useAuth();
  const codeEnabled = kernel.descriptors.some((d) => d.id === 'code' && d.enabled);

  const [repos, setRepos] = useState<RepoRecord[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [repo, setRepo] = useState('');
  const [skill, setSkill] = useState(query.get('skill') ?? '');

  // Dry-run deep links can land while the page is already mounted (skills →
  // lab → skills → another dry-run) — follow the query, don't trust mount time.
  const querySkill = query.get('skill') ?? '';
  useEffect(() => {
    if (querySkill) setSkill(querySkill);
  }, [querySkill]);
  const [prompt, setPrompt] = useState('');
  const [timeoutMs, setTimeoutMs] = useState<number>(180_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PlaygroundRunResult | null>(null);

  useEffect(() => {
    if (codeEnabled && can('repos:read')) {
      void codeApi
        .listRepos()
        .then((r) => setRepos(r.repos))
        .catch(() => setRepos([]));
    }
    if (can('skills:manage')) {
      void operateApi
        .listSkills()
        .then((r) => setSkills(r.skills.map((s) => s.name)))
        .catch(() => setSkills([]));
    }
  }, [codeEnabled, can]);

  const run = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await playgroundApi.run({
          prompt: prompt.trim(),
          repo: repo || undefined,
          skill: skill || undefined,
          timeoutMs,
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page>
      <PageHeader
        title="Agent Lab"
        subtitle="Try a prompt against a real agent run — read-only fenced, nothing is applied"
      />
      <ErrorBar error={error} />

      <form className="card flex flex-col gap-3 p-4" onSubmit={(e) => void run(e)}>
        <Field label={skill ? 'Test input — what should the agent apply the skill to?' : 'Prompt'}>
          <textarea
            className="input min-h-32 w-full resize-y font-mono text-xs leading-relaxed"
            placeholder="e.g. Review the error handling in the sync module and describe what you would change."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            autoFocus
          />
        </Field>
        <div className="flex flex-wrap items-end gap-3">
          {repos.length > 0 ? (
            <Field label="Repository (optional)">
              <select className="input input-sm" value={repo} onChange={(e) => setRepo(e.target.value)}>
                <option value="">Scratch — no repository</option>
                {repos.map((r) => (
                  <option key={r.fullName} value={r.fullName} disabled={!r.cloneReady}>
                    {r.fullName}
                    {r.cloneReady ? '' : ' (no clone yet)'}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          {skills.length > 0 ? (
            <Field label="Skill to preload (optional)">
              <select className="input input-sm" value={skill} onChange={(e) => setSkill(e.target.value)}>
                <option value="">None</option>
                {skills.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          <Field label="Time limit">
            <select
              className="input input-sm"
              value={timeoutMs}
              onChange={(e) => setTimeoutMs(Number(e.target.value))}
            >
              {TIMEOUTS.map((t) => (
                <option key={t.ms} value={t.ms}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          <button
            className={`flex h-9 cursor-pointer items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors disabled:cursor-default disabled:opacity-50 ${aiAccentClass(false)}`}
            type="submit"
            disabled={busy || prompt.trim().length < 4}
          >
            <SparkleIcon />
            {busy ? 'Running…' : skill ? 'Dry-run skill' : 'Run'}
          </button>
        </div>
        {skill ? (
          <p className="dim text-xs">
            Dry run: the skill&apos;s content is inlined into the prompt, and the agent only reports what it
            would do — no files change, no state changes.
          </p>
        ) : null}
      </form>

      {busy ? (
        <div className="dim mt-4 flex items-center gap-2 text-sm">
          <Spinner /> The agent is exploring — this can take a few minutes. The run also appears under Agent
          Runs.
        </div>
      ) : null}

      {result ? <ResultCard result={result} /> : null}
    </Page>
  );
}

function ResultCard({ result }: { result: PlaygroundRunResult }): JSX.Element {
  return (
    <div className="card mt-4 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="dim text-[10px] font-medium tracking-widest uppercase">
          {result.message === null ? 'Run failed' : 'Agent answer'}
        </span>
        <a className="linkish text-xs" href={`#/runs/${result.runId}`}>
          Open transcript →
        </a>
      </div>
      {result.message === null ? (
        <p className="dim text-sm">
          The run finished without a final message — it may have hit its time limit. The transcript has the
          full story.
        </p>
      ) : (
        <Markdown text={result.message} />
      )}
    </div>
  );
}
