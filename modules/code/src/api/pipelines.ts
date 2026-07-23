import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SpaServerMessage } from '@companion/contracts';
import type {
  PipelineRecord,
  PipelineRunRecord,
  PipelineStep,
  PipelineStepKind,
  PipelineStepResult,
  PipelineStepSpec,
  PipelineTrigger,
  PrRecord,
  StepDefinitionRecord,
  IssueRecord,
  PipelineType,
} from '../contract/index.js';
import { PIPELINE_TYPE_STEPS } from '../contract/index.js';
import { log, extractModelJson } from '@companion/services';
import type { CodeStore } from './code-store.js';
import type { Orchestrator, Checkouts } from './operate-types.js';
import type { GitHubClient } from './github-client.js';
import type { PrReviews } from './pr-reviews.js';
import { describeChecks, type PrChecks } from './pr-checks.js';

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
  z.object({
    kind: z.literal('slop-check'),
    ...stepBase,
    config: z.object({ threshold: z.number().int().min(1).max(100) }),
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

export const savePipelineSchema = z
  .object({
    type: z.enum(['pr', 'issue', 'platform']).default('pr'),
    name: z.string().min(1).max(100),
    description: z.string().max(500).default(''),
    steps: z.array(stepSpecSchema).min(1).max(20),
    autoRunOnPrOpen: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    // Inline steps must fit the pipeline type's payload; library refs are
    // re-checked when the run resolves them.
    const allowed = PIPELINE_TYPE_STEPS[v.type];
    v.steps.forEach((spec, i) => {
      if (spec.type === 'inline' && !allowed.includes(spec.step.kind)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['steps', i],
          message: `step kind "${spec.step.kind}" is not allowed in a ${v.type} pipeline`,
        });
      }
    });
    if (v.type === 'platform' && v.autoRunOnPrOpen) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['autoRunOnPrOpen'],
        message: 'platform pipelines run manually',
      });
    }
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

/**
 * Structural seam to module-slop's detection service. Slop `dependsOn` code, so
 * code must not import its contract (a workspace cycle) — the engine resolves
 * the service at run time and a disabled/missing slop module surfaces as a
 * step error, never a crash. Kept in lockstep with SlopService.detectForGate.
 */
export interface SlopGateService {
  detectForGate(
    repo: string,
    prNumber: number,
    userId: string,
  ): Promise<{ aiLikelihood: number; confidence: string; summary: string; detail: string | null }>;
}

interface EngineDeps {
  readonly store: CodeStore;
  readonly orchestrator: Orchestrator;
  readonly checkouts: Checkouts;
  readonly github: (ctx?: { repo?: string; accountId?: string; username?: string | null }) => GitHubClient | null;
  readonly checks: PrChecks;
  readonly reviews: PrReviews;
  /** Lazily resolved per run — slop registers after code in topo order. */
  readonly slop: () => SlopGateService | null;
}

interface StepContext {
  readonly repo: string;
  readonly userId: string;
  readonly type: PipelineType;
  /** Present for pr-type runs. */
  readonly pr: PrRecord | null;
  /** Present for issue-type runs. */
  readonly issue: IssueRecord | null;
}

/** The commentable/labelable target of a run (pr or issue), if any. */
function targetOf(ctx: StepContext): { number: number; title: string; author: string } | null {
  if (ctx.pr) return { number: ctx.pr.number, title: ctx.pr.title, author: ctx.pr.author };
  if (ctx.issue) return { number: ctx.issue.number, title: ctx.issue.title, author: ctx.issue.author };
  return null;
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

function createStepRegistry(deps: EngineDeps): StepRegistry {
  return {
    'checks-gate': async (step, ctx) => {
      if (!ctx.pr) return { status: 'error', summary: 'CI checks gate only applies to PR pipelines' };
      const summary = await deps.checks.fetchSummary(ctx.repo, ctx.pr.number, ctx.userId);
      const line = `${summary.passed} passed, ${summary.failed} failed, ${summary.pending} running`;
      if (summary.state === 'failing') {
        return { status: 'failed', summary: `CI failing — ${line}`, detail: describeChecks(summary) };
      }
      if (summary.state === 'pending' && !step.config.allowPending) {
        return { status: 'failed', summary: `CI still running — ${line}`, detail: describeChecks(summary) };
      }
      if (summary.state === 'unknown') {
        // Can't verify ≠ green — a gate that passes on a failed fetch is no gate.
        return { status: 'failed', summary: 'CI status unavailable (GitHub fetch failed)', detail: describeChecks(summary) };
      }
      const label = summary.state === 'none' ? 'no CI configured' : `CI ${summary.state} — ${line}`;
      return { status: 'passed', summary: label, detail: describeChecks(summary) };
    },

    'ai-review': async (step, ctx) => {
      if (!ctx.pr) return { status: 'error', summary: 'AI review only applies to PR pipelines' };
      const result = await deps.reviews.analyzePr(ctx.repo, ctx.pr.number, ctx.userId);
      if (!result.verdict) {
        return { status: 'error', summary: result.error ?? 'review produced no verdict' };
      }
      let posted = '';
      if (step.config.post) {
        try {
          await deps.reviews.apply(result.id, undefined, ctx.userId);
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
      let prompt: string;
      let title: string;
      if (ctx.pr) {
        const checksSummary = await deps.checks.trySummary(ctx.repo, ctx.pr.number, ctx.userId);
        prompt = agentStepPrompt(step.config.prompt, ctx.pr, describeChecks(checksSummary));
        title = `Pipeline step "${step.name}" on PR #${ctx.pr.number}`;
      } else if (ctx.issue) {
        prompt = agentIssueStepPrompt(step.config.prompt, ctx.issue);
        title = `Pipeline step "${step.name}" on issue #${ctx.issue.number}`;
      } else {
        prompt = agentPlatformStepPrompt(step.config.prompt, ctx.repo);
        title = `Pipeline step "${step.name}" on ${ctx.repo}`;
      }
      const run = (cwd: string) =>
        deps.orchestrator.runOneShot({
          kind: 'analysis',
          task: 'code.pipeline',
          title,
          cwd,
          repo: ctx.repo,
          userId: ctx.userId,
          issueNumber: targetOf(ctx)?.number ?? null,
          prompt,
          timeoutMs: 12 * 60_000,
        });
      const { finalMessage } = ctx.pr
        ? await deps.checkouts.withPullRequestWorktree(
            ctx.repo,
            `pipeline-${ctx.pr.number}-${randomUUID().slice(0, 8)}`,
            ctx.pr.number,
            ctx.pr.baseRef,
            run,
            undefined,
            ctx.userId,
          )
        : await run(deps.checkouts.cloneDir(ctx.repo));
      const verdict = agentVerdictSchema.parse(extractModelJson(finalMessage ?? ''));
      return {
        status: verdict.pass ? 'passed' : 'failed',
        summary: verdict.summary,
        detail: verdict.detail ?? null,
      };
    },

    label: async (step, ctx) => {
      const target = targetOf(ctx);
      if (!target) return { status: 'error', summary: 'label steps need a PR or issue target' };
      const client = deps.github({ repo: ctx.repo, username: ctx.userId });
      if (!client) return { status: 'error', summary: 'GitHub is not configured' };
      await client.addLabels(ctx.repo, target.number, [...step.config.labels]);
      return { status: 'passed', summary: `added ${step.config.labels.join(', ')}` };
    },

    comment: async (step, ctx) => {
      const target = targetOf(ctx);
      if (!target) return { status: 'error', summary: 'comment steps need a PR or issue target' };
      const client = deps.github({ repo: ctx.repo, username: ctx.userId });
      if (!client) return { status: 'error', summary: 'GitHub is not configured' };
      const body = step.config.body
        .replaceAll('{{pr.number}}', String(target.number))
        .replaceAll('{{pr.title}}', target.title)
        .replaceAll('{{pr.author}}', target.author)
        .replaceAll('{{issue.number}}', String(target.number))
        .replaceAll('{{issue.title}}', target.title)
        .replaceAll('{{issue.author}}', target.author)
        .replaceAll('{{repo}}', ctx.repo);
      await client.comment(ctx.repo, target.number, body);
      return { status: 'passed', summary: 'comment posted' };
    },

    'slop-check': async (step, ctx) => {
      if (!ctx.pr) return { status: 'error', summary: 'slop check only applies to PR pipelines' };
      const slop = deps.slop();
      if (!slop) return { status: 'error', summary: 'the AI Slop Detection module is not enabled' };
      // Runs a fresh detection; the verdict also lands as a pending result on
      // the slop page, so a failing gate arrives with its evidence attached.
      const verdict = await slop.detectForGate(ctx.repo, ctx.pr.number, ctx.userId);
      return {
        status: verdict.aiLikelihood >= step.config.threshold ? 'failed' : 'passed',
        summary: `AI likelihood ${verdict.aiLikelihood}/100 (${verdict.confidence} confidence) — ${verdict.summary}`,
        detail: verdict.detail,
      };
    },
  };
}

function agentIssueStepPrompt(instructions: string, issue: IssueRecord): string {
  return `You are a pipeline step evaluating a GitHub issue against the repository checked out in the current directory.

READ-ONLY RULES (mandatory): you may read files and search the codebase, but you must NOT modify anything. Your ONLY output is the final JSON.

## Step instructions
${instructions}

## Issue #${issue.number}: ${issue.title}
Author: ${issue.author}
Labels: ${issue.labels.join(', ') || '(none)'}

${issue.body || '(no description)'}

## Verdict
Reply with ONLY a JSON object: { "pass": boolean, "summary": "<one line>", "detail": "<optional longer notes>" }`;
}

function agentPlatformStepPrompt(instructions: string, repo: string): string {
  return `You are a platform pipeline step running against the repository ${repo}, checked out in the current directory.

READ-ONLY RULES (mandatory): you may read files and search the codebase, but you must NOT modify anything. Your ONLY output is the final JSON.

## Step instructions
${instructions}

## Verdict
Reply with ONLY a JSON object: { "pass": boolean, "summary": "<one line>", "detail": "<optional longer notes>" }`;
}

function agentStepPrompt(instructions: string, pr: PrRecord, checks: string): string {
  return `You are a pipeline step evaluating a GitHub pull request whose exact head is checked out in the current directory.

READ-ONLY RULES (mandatory): you may read files and search the codebase, but you must NOT modify anything. Your ONLY output is the final JSON.

## Step instructions
${instructions}

## PR #${pr.number}: ${pr.title}
Author: ${pr.author}

${pr.body || '(no description)'}

## CI pipelines
${checks}

## Inspecting the complete PR
\`origin/${pr.baseRef}\` is the refreshed base. Inspect the complete change locally; no prompt-sized diff was provided.

- Start with \`git diff --stat origin/${pr.baseRef}...HEAD\`, \`git diff --numstat origin/${pr.baseRef}...HEAD\`, and \`git diff --name-only origin/${pr.baseRef}...HEAD\`.
- Inspect changed files in bounded groups with \`git diff origin/${pr.baseRef}...HEAD -- <path>...\`; do not dump an oversized whole-PR diff into one tool call.
- Cover every changed file relevant to the step instructions. Generated, vendored, lock, and binary files may be classified and sampled instead of expanded line-by-line.
- If collaboration/subagent tools are available, delegate disjoint file groups and synthesize their evidence yourself. Do not assume delegation exists.

Apply the step instructions to this PR, then reply with ONLY a JSON object (no fence, no prose):
{
  "pass": true | false,
  "summary": "<one sentence: why this step passes or fails>",
  "detail": "<optional longer markdown explanation>"
}`;
}

// ---------- engine -------------------------------------------------------------------

export type ResolvedStep =
  | { readonly ok: true; readonly step: PipelineStep }
  | { readonly ok: false; readonly name: string; readonly reason: string };

export class Pipelines {
  private readonly registry: StepRegistry;

  constructor(
    private readonly deps: EngineDeps,
    private readonly broadcast: (msg: SpaServerMessage) => void,
  ) {
    this.registry = createStepRegistry(deps);
    const swept = deps.store.pipelines.markInterruptedRuns();
    if (swept > 0) log.info(`marked ${swept} pipeline run(s) interrupted from previous daemon life`);
  }

  // ---------- definitions CRUD ---------------------------------------------------

  list(workspaceId: string): PipelineRecord[] {
    return this.deps.store.pipelines.list(workspaceId);
  }

  create(workspaceId: string, input: z.infer<typeof savePipelineSchema>): PipelineRecord {
    const now = Date.now();
    const record: PipelineRecord = {
      id: `pl-${randomUUID().slice(0, 12)}`,
      workspaceId,
      type: input.type,
      name: input.name,
      description: input.description,
      steps: input.steps as PipelineStepSpec[],
      autoRunOnPrOpen: input.autoRunOnPrOpen,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.store.pipelines.insert(record);
    this.broadcast({ t: 'pipelines.changed' });
    return record;
  }

  update(id: string, input: Partial<z.infer<typeof savePipelineSchema>>): PipelineRecord {
    const existing = this.deps.store.pipelines.get(id);
    if (!existing) throw new Error(`unknown pipeline ${id}`);
    this.deps.store.pipelines.update(id, {
      type: input.type,
      name: input.name,
      description: input.description,
      steps: input.steps as PipelineStepSpec[] | undefined,
      autoRunOnPrOpen: input.autoRunOnPrOpen,
    });
    this.broadcast({ t: 'pipelines.changed' });
    return this.deps.store.pipelines.get(id)!;
  }

  remove(id: string): void {
    this.deps.store.pipelines.delete(id);
    this.broadcast({ t: 'pipelines.changed' });
  }

  // ---------- step library CRUD ----------------------------------------------------

  listStepDefinitions(workspaceId: string): StepDefinitionRecord[] {
    return this.deps.store.pipelines.listStepDefinitions(workspaceId);
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
    this.deps.store.pipelines.insertStepDefinition(record);
    this.broadcast({ t: 'pipelines.changed' });
    return record;
  }

  updateStepDefinition(
    id: string,
    input: Partial<z.infer<typeof saveStepDefinitionSchema>>,
  ): StepDefinitionRecord {
    const existing = this.deps.store.pipelines.getStepDefinition(id);
    if (!existing) throw new Error(`unknown step definition ${id}`);
    this.deps.store.pipelines.updateStepDefinition(id, {
      name: input.name,
      description: input.description,
      step: input.step ? { ...(input.step as PipelineStep), name: input.name ?? existing.name } : undefined,
    });
    this.broadcast({ t: 'pipelines.changed' });
    return this.deps.store.pipelines.getStepDefinition(id)!;
  }

  removeStepDefinition(id: string): void {
    this.deps.store.pipelines.deleteStepDefinition(id);
    this.broadcast({ t: 'pipelines.changed' });
  }

  // ---------- execution --------------------------------------------------------------

  /**
   * Start a pipeline against a PR. Returns the freshly inserted run record;
   * execution continues in the background and streams over pipelineRuns.changed.
   */
  start(
    pipelineId: string,
    repo: string,
    targetNumber: number,
    trigger: PipelineTrigger,
    userId: string,
  ): PipelineRunRecord {
    const pipeline = this.deps.store.pipelines.get(pipelineId);
    if (!pipeline) throw new Error(`unknown pipeline ${pipelineId}`);
    // The pipeline's type decides the payload it needs.
    let pr: PrRecord | null = null;
    let issue: IssueRecord | null = null;
    if (pipeline.type === 'pr') {
      pr = this.deps.store.prs.get(repo, targetNumber) ?? null;
      if (!pr) throw new Error(`unknown PR ${repo}#${targetNumber}`);
    } else if (pipeline.type === 'issue') {
      issue = this.deps.store.issues.get(repo, targetNumber) ?? null;
      if (!issue) throw new Error(`unknown issue ${repo}#${targetNumber}`);
    } else if (!this.deps.store.repos.get(repo)) {
      throw new Error(`repo ${repo} is not connected`);
    }

    const resolved = this.resolveSteps(pipeline.steps, pipeline.type);
    const run: PipelineRunRecord = {
      id: `plr-${randomUUID().slice(0, 12)}`,
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      target: pipeline.type,
      repo,
      prNumber: targetNumber,
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
    this.deps.store.pipelines.insertRun(run);
    this.broadcast({ t: 'pipelineRuns.changed', repo });

    void this.execute(run.id, resolved, { repo, userId, type: pipeline.type, pr, issue }).catch((err) => {
      log.warn('pipeline run crashed', { runId: run.id, err: String(err) });
    });
    return run;
  }

  /** Webhook hook: run every auto-run PR pipeline of the repo's workspace. */
  autoRunForPr(repo: string, prNumber: number, userId: string): void {
    this.autoRun(repo, prNumber, 'pr', 'pr-opened', userId);
  }

  /** Webhook hook: run every auto-run issue pipeline of the repo's workspace. */
  autoRunForIssue(repo: string, issueNumber: number, userId: string): void {
    this.autoRun(repo, issueNumber, 'issue', 'issue-opened', userId);
  }

  private autoRun(repo: string, number: number, type: PipelineType, trigger: PipelineTrigger, userId: string): void {
    const auto = this.deps.store.repos
      .workspaceIds(repo)
      .flatMap((workspaceId) => this.deps.store.pipelines.list(workspaceId))
      .filter((p) => p.autoRunOnPrOpen && p.type === type);
    for (const pipeline of auto) {
      try {
        this.start(pipeline.id, repo, number, trigger, userId);
        log.info('auto-run pipeline started', { pipeline: pipeline.name, repo, number });
      } catch (err) {
        log.warn('auto-run pipeline failed to start', { pipeline: pipeline.name, err: String(err) });
      }
    }
  }

  /** Public (not just for start()): module-playground's zero-side-effect
   *  preview resolves through here so there is exactly one resolution rule. */
  resolveSteps(specs: ReadonlyArray<PipelineStepSpec>, type: PipelineType): ResolvedStep[] {
    const allowed = PIPELINE_TYPE_STEPS[type];
    return specs.map((spec) => {
      if (spec.type === 'inline') {
        if (!allowed.includes(spec.step.kind)) {
          return { ok: false, name: spec.step.name, reason: `"${spec.step.kind}" steps are not allowed in ${type} pipelines` };
        }
        return { ok: true, step: spec.step };
      }
      const def = this.deps.store.pipelines.getStepDefinition(spec.stepDefinitionId);
      if (!def) {
        return {
          ok: false,
          name: spec.overrides?.name ?? 'library step',
          reason: `step definition ${spec.stepDefinitionId} no longer exists`,
        };
      }
      if (!allowed.includes(def.step.kind)) {
        return {
          ok: false,
          name: spec.overrides?.name ?? def.name,
          reason: `"${def.step.kind}" steps are not allowed in ${type} pipelines`,
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
      ...(this.deps.store.pipelines.getRun(runId)?.steps ?? []),
    ];
    const save = (): void => {
      this.deps.store.pipelines.updateRun(runId, { steps });
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
    this.deps.store.pipelines.updateRun(runId, { status, steps, finishedAt: Date.now() });
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
