import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  PipelineRecord,
  PipelineRunRecord,
  PipelineStep,
  PipelineStepKind,
  PipelineStepResult,
  PipelineStepSpec,
  PipelineTrigger,
  PrRecord,
  SpaServerMessage,
  StepDefinitionRecord,
} from '@companion/contract';
import { log } from '../log.js';
import type { Store } from '../store/db.js';
import type { Orchestrator } from '../runs/orchestrator.js';
import type { Checkouts } from '../git/checkouts.js';
import type { GitHubClient } from '../github/client.js';
import type { PrReviews } from '../prs/reviews.js';
import { describeChecks, type PrChecks } from '../prs/checks.js';
import { extractModelJson } from '../lib/model-json.js';

/**
 * User-defined PR pipelines. The engine resolves a pipeline's step specs
 * (inline steps + step-library references) into concrete steps, then walks
 * them sequentially through the step registry. One handler per step kind —
 * the `StepRegistry` mapped type makes "add a kind" a compile error until a
 * handler exists.
 */

// ---------- zod schemas (route bodies validate against these) ----------------------

const stepBase = {
  name: z.string().min(1).max(80),
  onFailure: z.enum(['halt', 'continue']),
};

export const pipelineStepSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('checks-gate'),
    ...stepBase,
    config: z.object({ allowPending: z.boolean() }),
  }),
  z.object({
    kind: z.literal('ai-review'),
    ...stepBase,
    config: z.object({
      post: z.boolean(),
      failOn: z.enum(['request_changes', 'high_risk', 'never']),
    }),
  }),
  z.object({
    kind: z.literal('agent'),
    ...stepBase,
    config: z.object({ prompt: z.string().min(1).max(20_000) }),
  }),
  z.object({
    kind: z.literal('label'),
    ...stepBase,
    config: z.object({ labels: z.array(z.string().min(1).max(50)).min(1).max(8) }),
  }),
  z.object({
    kind: z.literal('comment'),
    ...stepBase,
    config: z.object({ body: z.string().min(1).max(20_000) }),
  }),
]);

export const stepSpecSchema = z.union([
  z.object({ type: z.literal('inline'), step: pipelineStepSchema }),
  z.object({
    type: z.literal('ref'),
    stepDefinitionId: z.string().min(1),
    overrides: z
      .object({
        name: z.string().min(1).max(80).optional(),
        onFailure: z.enum(['halt', 'continue']).optional(),
      })
      .optional(),
  }),
]);

export const savePipelineSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).default(''),
  steps: z.array(stepSpecSchema).min(1).max(20),
  autoRunOnPrOpen: z.boolean().default(false),
});

export const saveStepDefinitionSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).default(''),
  step: pipelineStepSchema,
});

// ---------- step execution ----------------------------------------------------------

interface StepOutcome {
  readonly status: 'passed' | 'failed' | 'error';
  readonly summary: string;
  readonly detail?: string | null;
}

interface EngineDeps {
  readonly store: Store;
  readonly orchestrator: Orchestrator;
  readonly checkouts: Checkouts;
  readonly github: (ctx?: { repo?: string; accountId?: string }) => GitHubClient | null;
  readonly checks: PrChecks;
  readonly reviews: PrReviews;
}

interface StepContext {
  readonly repo: string;
  readonly pr: PrRecord;
}

type HandlerFor<K extends PipelineStepKind> = (
  step: Extract<PipelineStep, { kind: K }>,
  ctx: StepContext,
) => Promise<StepOutcome>;

/** One handler per kind; exhaustiveness enforced by the mapped type. */
type StepRegistry = { readonly [K in PipelineStepKind]: HandlerFor<K> };

const agentVerdictSchema = z.object({
  pass: z.boolean(),
  summary: z.string(),
  detail: z.string().optional(),
});

const MAX_DIFF_CHARS = 60_000;

function createStepRegistry(deps: EngineDeps): StepRegistry {
  return {
    'checks-gate': async (step, ctx) => {
      const summary = await deps.checks.fetchSummary(ctx.repo, ctx.pr.number);
      const line = `${summary.passed} passed, ${summary.failed} failed, ${summary.pending} running`;
      if (summary.state === 'failing') {
        return { status: 'failed', summary: `CI failing — ${line}`, detail: describeChecks(summary) };
      }
      if (summary.state === 'pending' && !step.config.allowPending) {
        return { status: 'failed', summary: `CI still running — ${line}`, detail: describeChecks(summary) };
      }
      const label = summary.state === 'none' ? 'no CI configured' : `CI ${summary.state} — ${line}`;
      return { status: 'passed', summary: label, detail: describeChecks(summary) };
    },

    'ai-review': async (step, ctx) => {
      const result = await deps.reviews.analyzePr(ctx.repo, ctx.pr.number);
      if (!result.verdict) {
        return { status: 'error', summary: result.error ?? 'review produced no verdict' };
      }
      let posted = '';
      if (step.config.post) {
        try {
          await deps.reviews.apply(result.id);
          posted = ', posted to GitHub';
        } catch (err) {
          posted = `, posting failed: ${String(err)}`;
        }
      }
      const { risk, recommendation, reviewBody } = result.verdict;
      const failed =
        (step.config.failOn === 'request_changes' && recommendation === 'request_changes') ||
        (step.config.failOn === 'high_risk' && risk === 'high');
      return {
        status: failed ? 'failed' : 'passed',
        summary: `risk ${risk}, recommends ${recommendation.replace('_', ' ')}${posted}`,
        detail: reviewBody,
      };
    },

    agent: async (step, ctx) => {
      if (!deps.checkouts.hasClone(ctx.repo)) {
        return { status: 'error', summary: `repo ${ctx.repo} has no clone yet` };
      }
      const client = deps.github({ repo: ctx.repo });
      if (!client) return { status: 'error', summary: 'GitHub is not configured' };
      const [diff, checksSummary] = await Promise.all([
        client.prDiff(ctx.repo, ctx.pr.number),
        deps.checks.trySummary(ctx.repo, ctx.pr.number),
      ]);
      const clipped =
        diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated)` : diff;
      const { finalMessage } = await deps.orchestrator.runOneShot({
        kind: 'analysis',
        title: `Pipeline step "${step.name}" on PR #${ctx.pr.number}`,
        cwd: deps.checkouts.cloneDir(ctx.repo),
        repo: ctx.repo,
        issueNumber: ctx.pr.number,
        prompt: agentStepPrompt(step.config.prompt, ctx.pr, clipped, describeChecks(checksSummary)),
        timeoutMs: 8 * 60_000,
      });
      const verdict = agentVerdictSchema.parse(extractModelJson(finalMessage ?? ''));
      return {
        status: verdict.pass ? 'passed' : 'failed',
        summary: verdict.summary,
        detail: verdict.detail ?? null,
      };
    },

    label: async (step, ctx) => {
      const client = deps.github({ repo: ctx.repo });
      if (!client) return { status: 'error', summary: 'GitHub is not configured' };
      await client.addLabels(ctx.repo, ctx.pr.number, [...step.config.labels]);
      return { status: 'passed', summary: `added ${step.config.labels.join(', ')}` };
    },

    comment: async (step, ctx) => {
      const client = deps.github({ repo: ctx.repo });
      if (!client) return { status: 'error', summary: 'GitHub is not configured' };
      const body = step.config.body
        .replaceAll('{{pr.number}}', String(ctx.pr.number))
        .replaceAll('{{pr.title}}', ctx.pr.title)
        .replaceAll('{{pr.author}}', ctx.pr.author)
        .replaceAll('{{repo}}', ctx.repo);
      await client.comment(ctx.repo, ctx.pr.number, body);
      return { status: 'passed', summary: 'comment posted' };
    },
  };
}

function agentStepPrompt(instructions: string, pr: PrRecord, diff: string, checks: string): string {
  return `You are a pipeline step evaluating a GitHub pull request against the repository checked out in the current directory.

READ-ONLY RULES (mandatory): you may read files and search the codebase, but you must NOT modify anything. Your ONLY output is the final JSON.

## Step instructions
${instructions}

## PR #${pr.number}: ${pr.title}
Author: ${pr.author}

${pr.body || '(no description)'}

## CI pipelines
${checks}

## Diff
\`\`\`diff
${diff}
\`\`\`

Apply the step instructions to this PR, then reply with ONLY a JSON object (no fence, no prose):
{
  "pass": true | false,
  "summary": "<one sentence: why this step passes or fails>",
  "detail": "<optional longer markdown explanation>"
}`;
}

// ---------- engine -------------------------------------------------------------------

type ResolvedStep =
  | { readonly ok: true; readonly step: PipelineStep }
  | { readonly ok: false; readonly name: string; readonly reason: string };

export class Pipelines {
  private readonly registry: StepRegistry;

  constructor(
    private readonly deps: EngineDeps,
    private readonly broadcast: (msg: SpaServerMessage) => void,
  ) {
    this.registry = createStepRegistry(deps);
    const swept = deps.store.markInterruptedPipelineRuns();
    if (swept > 0) log.info(`marked ${swept} pipeline run(s) interrupted from previous daemon life`);
  }

  // ---------- definitions CRUD ---------------------------------------------------

  list(workspaceId: string): PipelineRecord[] {
    return this.deps.store.listPipelines(workspaceId);
  }

  create(workspaceId: string, input: z.infer<typeof savePipelineSchema>): PipelineRecord {
    const now = Date.now();
    const record: PipelineRecord = {
      id: `pl-${randomUUID().slice(0, 12)}`,
      workspaceId,
      name: input.name,
      description: input.description,
      steps: input.steps as PipelineStepSpec[],
      autoRunOnPrOpen: input.autoRunOnPrOpen,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.store.insertPipeline(record);
    this.broadcast({ t: 'pipelines.changed' });
    return record;
  }

  update(id: string, input: Partial<z.infer<typeof savePipelineSchema>>): PipelineRecord {
    const existing = this.deps.store.getPipeline(id);
    if (!existing) throw new Error(`unknown pipeline ${id}`);
    this.deps.store.updatePipeline(id, {
      name: input.name,
      description: input.description,
      steps: input.steps as PipelineStepSpec[] | undefined,
      autoRunOnPrOpen: input.autoRunOnPrOpen,
    });
    this.broadcast({ t: 'pipelines.changed' });
    return this.deps.store.getPipeline(id)!;
  }

  remove(id: string): void {
    this.deps.store.deletePipeline(id);
    this.broadcast({ t: 'pipelines.changed' });
  }

  // ---------- step library CRUD ----------------------------------------------------

  listStepDefinitions(workspaceId: string): StepDefinitionRecord[] {
    return this.deps.store.listStepDefinitions(workspaceId);
  }

  createStepDefinition(
    workspaceId: string,
    input: z.infer<typeof saveStepDefinitionSchema>,
  ): StepDefinitionRecord {
    const now = Date.now();
    const record: StepDefinitionRecord = {
      id: `sd-${randomUUID().slice(0, 12)}`,
      workspaceId,
      name: input.name,
      description: input.description,
      step: { ...(input.step as PipelineStep), name: input.name },
      createdAt: now,
      updatedAt: now,
    };
    this.deps.store.insertStepDefinition(record);
    this.broadcast({ t: 'pipelines.changed' });
    return record;
  }

  updateStepDefinition(
    id: string,
    input: Partial<z.infer<typeof saveStepDefinitionSchema>>,
  ): StepDefinitionRecord {
    const existing = this.deps.store.getStepDefinition(id);
    if (!existing) throw new Error(`unknown step definition ${id}`);
    this.deps.store.updateStepDefinition(id, {
      name: input.name,
      description: input.description,
      step: input.step ? { ...(input.step as PipelineStep), name: input.name ?? existing.name } : undefined,
    });
    this.broadcast({ t: 'pipelines.changed' });
    return this.deps.store.getStepDefinition(id)!;
  }

  removeStepDefinition(id: string): void {
    this.deps.store.deleteStepDefinition(id);
    this.broadcast({ t: 'pipelines.changed' });
  }

  // ---------- execution --------------------------------------------------------------

  /**
   * Start a pipeline against a PR. Returns the freshly inserted run record;
   * execution continues in the background and streams over pipelineRuns.changed.
   */
  start(pipelineId: string, repo: string, prNumber: number, trigger: PipelineTrigger): PipelineRunRecord {
    const pipeline = this.deps.store.getPipeline(pipelineId);
    if (!pipeline) throw new Error(`unknown pipeline ${pipelineId}`);
    const pr = this.deps.store.getPr(repo, prNumber);
    if (!pr) throw new Error(`unknown PR ${repo}#${prNumber}`);

    const resolved = this.resolveSteps(pipeline.steps);
    const run: PipelineRunRecord = {
      id: `plr-${randomUUID().slice(0, 12)}`,
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      repo,
      prNumber,
      status: 'running',
      trigger,
      steps: resolved.map((r) =>
        r.ok
          ? pendingResult(r.step.name, r.step.kind)
          : { ...pendingResult(r.name, 'unknown'), status: 'error' as const, summary: r.reason },
      ),
      createdAt: Date.now(),
      finishedAt: null,
    };
    this.deps.store.insertPipelineRun(run);
    this.broadcast({ t: 'pipelineRuns.changed', repo });

    void this.execute(run.id, resolved, { repo, pr }).catch((err) => {
      log.warn('pipeline run crashed', { runId: run.id, err: String(err) });
    });
    return run;
  }

  /** Webhook hook: run every auto-run pipeline of the repo's workspace. */
  autoRunForPr(repo: string, prNumber: number): void {
    const repoRow = this.deps.store.getRepo(repo);
    if (!repoRow) return;
    const auto = this.deps.store.listPipelines(repoRow.workspace_id).filter((p) => p.autoRunOnPrOpen);
    for (const pipeline of auto) {
      try {
        this.start(pipeline.id, repo, prNumber, 'pr-opened');
        log.info('auto-run pipeline started', { pipeline: pipeline.name, repo, prNumber });
      } catch (err) {
        log.warn('auto-run pipeline failed to start', { pipeline: pipeline.name, err: String(err) });
      }
    }
  }

  private resolveSteps(specs: ReadonlyArray<PipelineStepSpec>): ResolvedStep[] {
    return specs.map((spec) => {
      if (spec.type === 'inline') return { ok: true, step: spec.step };
      const def = this.deps.store.getStepDefinition(spec.stepDefinitionId);
      if (!def) {
        return {
          ok: false,
          name: spec.overrides?.name ?? 'library step',
          reason: `step definition ${spec.stepDefinitionId} no longer exists`,
        };
      }
      return {
        ok: true,
        step: {
          ...def.step,
          name: spec.overrides?.name ?? def.name,
          onFailure: spec.overrides?.onFailure ?? def.step.onFailure,
        },
      };
    });
  }

  private async execute(runId: string, resolved: ResolvedStep[], ctx: StepContext): Promise<void> {
    const steps: PipelineStepResult[] = [
      ...(this.deps.store.getPipelineRun(runId)?.steps ?? []),
    ];
    const save = (): void => {
      this.deps.store.updatePipelineRun(runId, { steps });
      this.broadcast({ t: 'pipelineRuns.changed', repo: ctx.repo });
    };

    let halted = false;
    for (let i = 0; i < resolved.length; i++) {
      const entry = resolved[i]!;
      if (!entry.ok) {
        // Unresolvable ref was pre-marked as error; a halting failure policy
        // cannot be known without the definition, so halt conservatively.
        halted = true;
      }
      if (halted) {
        if (entry.ok) steps[i] = { ...steps[i]!, status: 'skipped' };
        continue;
      }
      const step = (entry as Extract<ResolvedStep, { ok: true }>).step;
      steps[i] = { ...steps[i]!, status: 'running', startedAt: Date.now() };
      save();

      let outcome: StepOutcome;
      try {
        outcome = await this.runStep(step, ctx);
      } catch (err) {
        outcome = { status: 'error', summary: String(err) };
      }
      steps[i] = {
        ...steps[i]!,
        status: outcome.status,
        summary: outcome.summary,
        detail: outcome.detail ?? null,
        finishedAt: Date.now(),
      };
      save();
      if (outcome.status !== 'passed' && step.onFailure === 'halt') halted = true;
    }

    const status = steps.some((s) => s.status === 'error')
      ? 'error'
      : steps.some((s) => s.status === 'failed')
        ? 'failed'
        : 'passed';
    this.deps.store.updatePipelineRun(runId, { status, steps, finishedAt: Date.now() });
    this.broadcast({ t: 'pipelineRuns.changed', repo: ctx.repo });
    log.info('pipeline run finished', { runId, status });
  }

  private runStep(step: PipelineStep, ctx: StepContext): Promise<StepOutcome> {
    const handler = this.registry[step.kind] as (s: PipelineStep, c: StepContext) => Promise<StepOutcome>;
    return handler(step, ctx);
  }
}

function pendingResult(name: string, kind: PipelineStepResult['kind']): PipelineStepResult {
  return { name, kind, status: 'pending', summary: null, detail: null, startedAt: null, finishedAt: null };
}
