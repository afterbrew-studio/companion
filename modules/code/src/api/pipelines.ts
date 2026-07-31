import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SpaServerMessage } from '@moxxy/companion-contracts';
import type {
  ImportedExecutableStep,
  ImportPreview,
  PipelineExport,
  PipelineRecord,
  PipelineRunRecord,
  PipelineStep,
  PipelineStepKind,
  PipelineStepResult,
  PipelineStepSpec,
  PipelineTrigger,
  PrRecord,
  StepCondition,
  StepDefinitionRecord,
  StepRemedy,
  StepVariable,
  IssueRecord,
  PipelineType,
} from '../contract/index.js';
import { PIPELINE_EXPORT_VERSION, PIPELINE_TYPE_STEPS } from '../contract/index.js';
import { log } from '@moxxy/companion-sdk/server';
import { extractModelJson } from '@moxxy/companion-sdk/agents';
import type { CodeStore } from './code-store.js';
import type { Orchestrator, Checkouts } from './operate-types.js';
import type { GitHubClient } from './github-client.js';
import type { PrReviews } from './pr-reviews.js';
import type { Fixes } from './fixes.js';
import { describeChecks, foldReviewDecision, type PrChecks } from './pr-checks.js';

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
  when: z
    .object({
      step: z.string().min(1).max(80),
      output: z.string().min(1).max(64),
      equals: z.string().max(500).optional(),
      oneOf: z.array(z.string().max(500)).max(20).optional(),
      not: z.string().max(500).optional(),
    })
    .optional(),
  requiresApproval: z.boolean().optional(),
};

const variableSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a valid environment variable name'),
    hidden: z.boolean(),
    value: z.string().max(4_000).optional(),
    secretKey: z.string().max(128).optional(),
    visibility: z.enum(['private', 'shared']).optional(),
    /** Server-owned. Accepted so the editor can round-trip a step it just read. */
    ownerId: z.string().max(128).optional(),
  })
  // A visible value is stored in the definition and travels in an export, so a
  // credential there would leak with the document. The fix is one checkbox.
  .refine((v) => v.hidden || noInlineCredential(v.value ?? ''), {
    message: 'that looks like a credential; tick "hidden" so it goes to the secret store instead',
  })
  .refine((v) => v.hidden || (v.value ?? '') !== '', { message: 'a visible variable needs a value' });

/** A variable that must be hidden, for a slot whose whole purpose is a credential. */
const hiddenVariableSchema = variableSchema.refine((v) => v.hidden, {
  message: 'this must be a hidden variable',
});

export const pipelineStepSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('checks-gate'),
    ...stepBase,
    config: z.object({
      allowPending: z.boolean(),
      requireProtectedContexts: z.boolean().optional(),
    }),
  }),
  z.object({
    kind: z.literal('pr-state-gate'),
    ...stepBase,
    config: z.object({
      requireReady: z.boolean(),
      requireApproved: z.boolean(),
      requireUpToDate: z.boolean(),
    }),
  }),
  z.object({
    kind: z.literal('pr-action'),
    ...stepBase,
    config: z.object({
      action: z.enum([
        'pr.rerun-failed',
        'pr.rerun-all',
        'pr.mark-ready',
        'pr.update-branch',
        'pr.fix-checks',
        'pr.analyze-checks',
        'pr.resolve-conflicts',
        'pr.address-reviews',
      ]),
    }),
  }),
  z.object({
    kind: z.literal('merge'),
    ...stepBase,
    config: z.object({
      method: z.enum(['merge', 'squash', 'rebase']),
      deleteBranch: z.boolean(),
      requirePinnedHead: z.boolean(),
    }),
  }),
  z.object({
    kind: z.literal('ai-review'),
    ...stepBase,
    config: z.object({
      post: z.boolean(),
      failOn: z.enum(['request_changes', 'high_risk', 'blocker', 'never']),
      // Optional so pipelines saved before anchored reviews keep validating.
      depth: z.enum(['high-level', 'in-depth']).optional(),
      strictness: z.enum(['blockers-only', 'balanced', 'pedantic']).optional(),
      verify: z.boolean().optional(),
      postMode: z.enum(['full', 'comments', 'summary']).optional(),
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
  z.object({
    kind: z.literal('executable'),
    ...stepBase,
    config: z.object({
      command: z.string().min(1).max(4_000).refine(noInlineCredential, {
        message:
          'put credentials in a hidden variable, never in the command: a shell that stays alive exposes its whole argv to `ps`',
      }),
      workdir: z.enum(['pr-worktree', 'clone']),
      // One hour: a publish plus a full inventory regeneration is minutes, not
      // seconds, and the old 10-minute verify ceiling is not enough for either.
      timeoutMs: z.number().int().min(1_000).max(60 * 60_000),
      variables: z.array(variableSchema).max(24),
      capture: z
        .array(z.object({ name: z.string().min(1).max(64), pattern: z.string().min(1).max(500) }))
        .max(8)
        .optional(),
      allowExitCodes: z.array(z.number().int().min(0).max(255)).max(8).optional(),
    }),
  }),
  z.object({
    kind: z.literal('npm-bootstrap'),
    ...stepBase,
    config: z.object({
      detectCommand: z.string().min(1).max(500),
      sectionPattern: z.string().min(1).max(500).optional(),
      packagePattern: z.string().min(1).max(500),
      countPattern: z.string().min(1).max(500),
      token: hiddenVariableSchema,
      // A filename, not a path: npm's trusted-publisher identity includes it,
      // which is why the workflow file must never move or be renamed.
      workflowFile: z.string().regex(/^[\w.-]+\.ya?ml$/, 'must be a workflow filename ending in .yml or .yaml'),
      dryRun: z.boolean(),
      timeoutMs: z.number().int().min(1_000).max(60 * 60_000),
    }),
  }),
]);

/**
 * Reject a credential typed straight into the command. Not a security boundary
 * (an author determined to leak one has many ways), but it catches the honest
 * mistake, and the honest mistake is the one that actually happens.
 */
function noInlineCredential(command: string): boolean {
  return !/(npm_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/.test(command);
}

export const pipelineExportSchema = z.object({
  // Only the major shape is pinned. A future version that adds an optional
  // field should still import here rather than being rejected as foreign.
  version: z.number().int().min(1).max(PIPELINE_EXPORT_VERSION),
  exportedAt: z.number().int().optional(),
  pipeline: z.object({
    type: z.enum(['pr', 'issue', 'platform']),
    name: z.string().min(1).max(120),
    description: z.string().max(2_000).default(''),
    steps: z.array(pipelineStepSchema).min(1).max(30),
    autoRunOnPrOpen: z.boolean().default(false),
  }),
});

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
  /** Values later steps may interpolate. Never secrets: these are persisted. */
  readonly outputs?: Readonly<Record<string, string>>;
  /** What to do about this failure, when there is something. */
  readonly remedies?: ReadonlyArray<StepRemedy>;
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
  /** Agent-backed PR repairs, for the `pr-action` step. */
  readonly fixes: Fixes;
  /** Lazily resolved per run — slop registers after code in topo order. */
  readonly slop: () => SlopGateService | null;
  /** This module's config: the executable kill switch and its secret fields. */
  readonly moduleConfig: { get(key: string): string | number | boolean | null };
  /** Run-time secret storage for hidden step variables. */
  readonly secrets: {
    get(key: string): string | null;
    set(key: string, value: string): void;
    delete(key: string): void;
    keys(): readonly string[];
  };
  readonly audit: (event: { action: string; access: string; status: number; detail: string; actor: string }) => void;
}

interface StepContext {
  readonly repo: string;
  readonly userId: string;
  readonly type: PipelineType;
  /** Present for pr-type runs. */
  readonly pr: PrRecord | null;
  /** Present for issue-type runs. */
  readonly issue: IssueRecord | null;
  /** Results of the steps that already ran, in order. Empty for the first step. */
  readonly completed: ReadonlyArray<PipelineStepResult>;
  /**
   * Whether the caller holds `pipelines:execute`. Resolved at the route from the
   * real user's role and carried in, so the engine never has to guess an identity
   * for work it started itself. Webhook auto-runs pass false unconditionally: a
   * push from GitHub must never be able to reach arbitrary code execution.
   */
  readonly allowExecutable: boolean;
  /** The PR head as it was when the run started; null for non-PR runs. */
  readonly pinnedHeadSha: string | null;
  /** Workspace the pipeline belongs to. Decides which secrets are in scope. */
  readonly workspaceId: string;
  /** Identifies the live output stream this step's chunks belong to. */
  readonly runId: string;
  readonly stepIndex: number;
}

/**
 * Should this step run at all?
 *
 * An unmet condition is not a failure: the step is simply not for this run, so
 * it is recorded as skipped and the pipeline carries on regardless of the
 * step's failure mode. A condition that cannot be evaluated (unknown step,
 * output never produced) is FALSE — skipping is the safe direction when the
 * state the condition asks about was never established.
 */
function conditionMet(when: StepCondition | undefined, completed: ReadonlyArray<PipelineStepResult>): boolean {
  if (!when) return true;
  const value = completed.find((s) => s.name === when.step)?.outputs?.[when.output];
  if (value === undefined) return false;
  if (when.equals !== undefined && value !== when.equals) return false;
  if (when.not !== undefined && value === when.not) return false;
  if (when.oneOf !== undefined && !when.oneOf.includes(value)) return false;
  return true;
}

/** The commentable/labelable target of a run (pr or issue), if any. */
function targetOf(ctx: StepContext): { number: number; title: string; author: string } | null {
  if (ctx.pr) return { number: ctx.pr.number, title: ctx.pr.title, author: ctx.pr.author };
  if (ctx.issue) return { number: ctx.issue.number, title: ctx.issue.title, author: ctx.issue.author };
  return null;
}

/** Lazy on purpose: step names are free text, so `node 22.x gate` has to resolve.
 *  A character class excluding `.` would silently fail to match such a name. */
const STEP_OUTPUT_RE = /\{\{steps\.(.+?)\.outputs\.(.+?)\}\}/g;

/**
 * Substitution for every step config field that takes user-authored text.
 *
 * An unresolved placeholder is left exactly as written rather than blanked: a
 * typo that survives into a posted comment is a visible bug report, while one
 * that silently becomes an empty string is not.
 */
function interpolate(text: string, ctx: StepContext): string {
  const target = targetOf(ctx);
  let out = text;
  if (target) {
    out = out
      .replaceAll('{{pr.number}}', String(target.number))
      .replaceAll('{{pr.title}}', target.title)
      .replaceAll('{{pr.author}}', target.author)
      .replaceAll('{{issue.number}}', String(target.number))
      .replaceAll('{{issue.title}}', target.title)
      .replaceAll('{{issue.author}}', target.author);
  }
  out = out.replaceAll('{{repo}}', ctx.repo);
  return out.replace(STEP_OUTPUT_RE, (whole, name: string, key: string) => {
    const step = ctx.completed.find((s) => s.name === name);
    return step?.outputs?.[key] ?? whole;
  });
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

function createStepRegistry(deps: EngineDeps, broadcast: (msg: SpaServerMessage) => void): StepRegistry {
  return {
    'checks-gate': async (step, ctx) => {
      if (!ctx.pr) return { status: 'error', summary: 'CI checks gate only applies to PR pipelines' };
      const summary = await deps.checks.fetchSummary(ctx.repo, ctx.pr.number, ctx.userId);
      const line = `${summary.passed} passed, ${summary.failed} failed, ${summary.pending} running`;
      const outputs = {
        state: summary.state,
        passed: String(summary.passed),
        failed: String(summary.failed),
        pending: String(summary.pending),
      };
      const detail = describeChecks(summary);
      if (summary.state === 'failing') {
        return {
          status: 'failed',
          summary: `CI failing — ${line}`,
          detail,
          outputs,
          remedies: [
            { action: 'pr.rerun-failed', label: 'Re-run failed jobs' },
            { action: 'pr.analyze-checks', label: 'Investigate with AI' },
            { action: 'pr.fix-checks', label: 'Repair with an agent' },
          ],
        };
      }
      if (summary.state === 'pending' && !step.config.allowPending) {
        return { status: 'failed', summary: `CI still running — ${line}`, detail, outputs };
      }
      if (summary.state === 'unknown') {
        // Can't verify ≠ green — a gate that passes on a failed fetch is no gate.
        return { status: 'failed', summary: 'CI status unavailable (GitHub fetch failed)', detail, outputs };
      }
      if (step.config.requireProtectedContexts) {
        const client = deps.github({ repo: ctx.repo, username: ctx.userId });
        if (!client) return { status: 'error', summary: 'GitHub is not configured', detail, outputs };
        const protection = await client.branchProtection(ctx.repo, ctx.pr.baseRef);
        if (protection === null) {
          return { status: 'failed', summary: `cannot read ${ctx.pr.baseRef} protection; refusing to assume`, detail, outputs };
        }
        // A wholly skipped suite reports zero failures. Insist on real passes.
        if (protection.requiredContexts.length > 0 && summary.passed === 0) {
          return { status: 'failed', summary: 'no check actually passed; CI never ran', detail, outputs };
        }
        const byName = new Map(summary.runs.map((r) => [r.name, r]));
        // Strictly `success`: a required context that was skipped or neutral has
        // not proven anything, and treating it as green is the exact hole this
        // check exists to close. A name absent from the map is unmet too.
        const unmet = protection.requiredContexts.filter((name) => {
          const run = byName.get(name);
          return !run || run.status !== 'completed' || run.conclusion !== 'success';
        });
        if (unmet.length > 0) {
          return {
            status: 'failed',
            summary: `required context(s) not green: ${unmet.join(', ')}`,
            detail,
            outputs,
            // Missing rather than red is usually a lane that never started, so
            // re-running everything is the fix, not re-running failures.
            remedies: [{ action: 'pr.rerun-all', label: 'Re-run all jobs' }],
          };
        }
      }
      const label = summary.state === 'none' ? 'no CI configured' : `CI ${summary.state} — ${line}`;
      return { status: 'passed', summary: label, detail, outputs };
    },

    'ai-review': async (step, ctx) => {
      if (!ctx.pr) return { status: 'error', summary: 'AI review only applies to PR pipelines' };
      const result = await deps.reviews.analyzePr(ctx.repo, ctx.pr.number, ctx.userId, {
        ...(step.config.depth ? { depth: step.config.depth } : {}),
        ...(step.config.strictness ? { strictness: step.config.strictness } : {}),
        ...(step.config.verify === undefined ? {} : { verify: step.config.verify }),
      });
      if (!result.verdict) {
        return { status: 'error', summary: result.error ?? 'review produced no verdict' };
      }
      let posted = '';
      if (step.config.post) {
        try {
          await deps.reviews.apply(result.id, {
            userId: ctx.userId,
            ...(step.config.postMode ? { mode: step.config.postMode } : {}),
          });
          posted = ', posted to GitHub';
        } catch (err) {
          posted = `, posting failed: ${String(err)}`;
        }
      }
      const { risk, recommendation, reviewBody } = result.verdict;
      const blockers = result.findings.filter((f) => f.severity === 'blocker' && f.verification !== 'refuted').length;
      const failed =
        (step.config.failOn === 'request_changes' && recommendation === 'request_changes') ||
        (step.config.failOn === 'high_risk' && risk === 'high') ||
        (step.config.failOn === 'blocker' && blockers > 0);
      const found = result.findings.length > 0 ? `, ${result.findings.length} finding(s)` : '';
      return {
        status: failed ? 'failed' : 'passed',
        summary: `risk ${risk}, recommends ${recommendation.replace('_', ' ')}${found}${posted}`,
        detail: reviewBody,
        outputs: { risk, recommendation, blockers: String(blockers) },
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
        outputs: { pass: String(verdict.pass) },
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
      await client.comment(ctx.repo, target.number, interpolate(step.config.body, ctx));
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
        outputs: { aiLikelihood: String(verdict.aiLikelihood), confidence: verdict.confidence },
      };
    },

    executable: async (step, ctx) => {
      // Two independent gates, both must be open. The instance switch is what an
      // operator controls; the permission is what a user holds. Neither implies
      // the other, and an instance that never enables the switch is unreachable
      // through this path regardless of who is signed in.
      if (deps.moduleConfig.get('allowExecutableSteps') !== true) {
        return { status: 'error', summary: 'executable steps are disabled on this instance' };
      }
      if (!ctx.allowExecutable) {
        return { status: 'error', summary: 'executable steps require the pipelines:execute permission' };
      }

      const { command, workdir, timeoutMs } = step.config;
      const env: Record<string, string> = {};
      const injected: string[] = [];
      const missing: string[] = [];
      // Visible first, hidden second, so a hidden value can never be shadowed by
      // a visible one of the same name.
      for (const v of step.config.variables) {
        if (!v.hidden) env[v.name] = interpolate(v.value ?? '', ctx);
      }
      for (const v of step.config.variables) {
        if (!v.hidden) continue;
        if (!v.secretKey) {
          missing.push(`${v.name} (no value set)`);
          continue;
        }
        // Ownership is checked against whoever STARTED this run, not whoever
        // wrote the step: that is what stops one profile's credential being
        // spent by another's run on a shared instance.
        const refusal = deps.store.pipelineSecrets.refusalFor(v.secretKey, ctx.userId, ctx.workspaceId);
        if (refusal) {
          missing.push(`${v.name} (${refusal})`);
          continue;
        }
        const value = deps.secrets.get(v.secretKey);
        if (value === null || value === '') missing.push(`${v.name} (no value set)`);
        else {
          env[v.name] = value;
          injected.push(value);
        }
      }
      // Running a publish with an unusable token would fail as "not
      // authenticated", which sends the operator to npm instead of to the
      // variable that actually refused.
      if (missing.length > 0) {
        return { status: 'error', summary: `hidden variable unavailable: ${missing.join('; ')}` };
      }

      if (workdir === 'pr-worktree' && !ctx.pr) {
        return { status: 'error', summary: 'this step needs a PR worktree, so it needs a PR target' };
      }
      if (!deps.checkouts.hasClone(ctx.repo)) {
        return { status: 'error', summary: `repo ${ctx.repo} has no clone yet` };
      }

      const resolved = interpolate(command, ctx);
      const backend = deps.orchestrator.runners.backend(null);
      const run = async (cwd: string): Promise<StepOutcome> => {
        // Through the scheduler, not straight at the backend: a command holds a
        // runner slot exactly like an agent run, and a bulk run over fifteen PRs
        // must wait for capacity rather than spawn fifteen shells at once.
        // Scrubbed on the way out, across chunk boundaries: a credential can
        // straddle two, and this text is about to be broadcast.
        const scrubber = chunkScrubber(injected);
        const emit = (chunk: string): void => {
          if (chunk) {
            broadcast({ t: 'pipelineStep.output', repo: ctx.repo, runId: ctx.runId, stepIndex: ctx.stepIndex, chunk });
          }
        };
        const result = await deps.orchestrator.schedule(
          { kind: 'command', title: `${step.name} on ${ctx.repo}`, repo: ctx.repo, userId: ctx.userId },
          () =>
            backend.exec(cwd, resolved, {
              timeoutMs,
              env,
              maxOutput: EXECUTABLE_MAX_OUTPUT,
              onChunk: (text) => emit(scrubber.push(text)),
            }),
        );
        emit(scrubber.flush());
        if (!result) return { status: 'error', summary: 'this runner cannot execute commands' };
        // Redact before ANYTHING else touches the text: it is about to become a
        // persisted step detail and a broadcast payload. Only the secret values,
        // not the plain env: blanking a deliberately visible value would make
        // the output unreadable for no gain.
        const output = redact(result.output, injected);
        deps.audit({
          actor: ctx.userId,
          action: 'pipeline executable step',
          access: 'pipelines:execute',
          status: result.exitCode === 0 ? 200 : 500,
          detail: `${ctx.repo} "${step.name}": ${resolved} [hidden vars: ${
            step.config.variables.filter((v) => v.hidden).map((v) => v.name).join(', ') || 'none'
          }] exit=${result.exitCode ?? 'signal'}${result.timedOut ? ' timedOut' : ''}`,
        });
        const allowed = step.config.allowExitCodes ?? [];
        const ok = result.exitCode === 0 || (result.exitCode !== null && allowed.includes(result.exitCode));
        const took = `${Math.round(result.durationMs / 1000)}s`;
        if (result.timedOut) {
          return { status: 'failed', summary: `timed out after ${took}`, detail: output };
        }
        return {
          status: ok ? 'passed' : 'failed',
          summary: `exit ${result.exitCode ?? 'signal'} in ${took}`,
          detail: output,
          outputs: capture(step.config.capture, output),
        };
      };

      return ctx.pr && workdir === 'pr-worktree'
        ? deps.checkouts.withPullRequestWorktree(
            ctx.repo,
            `exec-${ctx.pr.number}-${randomUUID().slice(0, 8)}`,
            ctx.pr.number,
            ctx.pr.baseRef,
            run,
            undefined,
            ctx.userId,
          )
        : run(deps.checkouts.cloneDir(ctx.repo));
    },

    'npm-bootstrap': async (step, ctx) => {
      if (deps.moduleConfig.get('allowExecutableSteps') !== true) {
        return { status: 'error', summary: 'executable steps are disabled on this instance' };
      }
      if (!ctx.allowExecutable) {
        return { status: 'error', summary: 'npm bootstrap requires the pipelines:execute permission' };
      }
      if (!deps.checkouts.hasClone(ctx.repo)) {
        return { status: 'error', summary: `repo ${ctx.repo} has no clone yet` };
      }

      const cfg = step.config;
      const backend = deps.orchestrator.runners.backend(null);

      const work = async (cwd: string): Promise<StepOutcome> => {
        const sh = async (
          command: string,
          env?: Record<string, string>,
        ): Promise<{ exitCode: number | null; output: string }> => {
          const r = await deps.orchestrator.schedule(
            { kind: 'command', title: `${step.name} on ${ctx.repo}`, repo: ctx.repo, userId: ctx.userId },
            () => backend.exec(cwd, command, { timeoutMs: cfg.timeoutMs, env, maxOutput: EXECUTABLE_MAX_OUTPUT }),
          );
          if (!r) throw new Error('this runner cannot execute commands');
          return { exitCode: r.exitCode, output: redact(r.output, env ? Object.values(env) : []) };
        };

        // Detection runs with NO credential. It also runs the branch's own
        // script, which is already arbitrary code from the pull request; that is
        // inherent to asking a repository what it needs and is why the publish
        // below passes --ignore-scripts.
        const detect = await sh(cfg.detectCommand);
        const declared = firstCapture(detect.output, cfg.countPattern);
        if (declared === null || !/^\d+$/.test(declared)) {
          return {
            status: 'error',
            summary: 'the detector printed no package count; refusing to guess',
            detail: detect.output,
          };
        }
        const found = allCaptures(section(detect.output, cfg.sectionPattern), cfg.packagePattern);
        // The cross-check is the point of the step. A detector whose wording
        // drifts must fail loudly, never read as "nothing to publish".
        if (found.length !== Number(declared)) {
          return {
            status: 'error',
            summary: `detector declares ${declared} package(s) needing bootstrap but ${found.length} parsed; fix the pattern before publishing`,
            detail: detect.output,
          };
        }
        if (found.length === 0) {
          return { status: 'passed', summary: 'no package needs bootstrap', outputs: { count: '0', packages: '' } };
        }

        const names = found.map(stripVersion);
        const bad = names.filter((n) => !SAFE_PACKAGE_NAME.test(n));
        if (bad.length > 0) {
          return { status: 'error', summary: `refusing unsafe package name(s): ${bad.join(', ')}` };
        }
        const outputs = { count: String(names.length), packages: names.join(' ') };

        if (cfg.dryRun) {
          return { status: 'passed', summary: `dry run — would publish ${names.join(', ')}`, outputs };
        }

        // Resolved here, not at the top: detection and the pack check need no
        // credential, so the token is not touched until something must publish.
        if (!cfg.token.secretKey) {
          return { status: 'error', summary: `no npm token set on "${step.name}"` };
        }
        const refusal = deps.store.pipelineSecrets.refusalFor(cfg.token.secretKey, ctx.userId, ctx.workspaceId);
        if (refusal) {
          return { status: 'error', summary: `npm token unavailable: ${refusal}` };
        }
        const token = deps.secrets.get(cfg.token.secretKey);
        if (token === null || token === '') {
          return { status: 'error', summary: `no npm token set on "${step.name}"` };
        }
        const env = { [NPM_AUTH_ENV]: token };

        const notes: string[] = [];
        for (const name of names) {
          // Proving the workspace protocol was rewritten needs no credential, so
          // it happens before the token is ever handed to a process.
          const packed = await sh(`pnpm --filter ${name} pack --pack-destination /tmp`);
          if (/workspace:/.test(packed.output)) {
            return { status: 'error', summary: `${name} still contains "workspace:" after packing; do not publish` };
          }

          const existing = await sh(`npm view ${name} version`, env);
          if (existing.exitCode === 0 && existing.output.trim()) {
            notes.push(`${name}@${existing.output.trim()} already on npm, skipped`);
            continue;
          }

          const pub = await sh(`pnpm --filter ${name} publish --access public --no-git-checks --ignore-scripts`, env);
          if (pub.exitCode !== 0) {
            return { status: 'failed', summary: `publishing ${name} failed`, detail: pub.output };
          }
          deps.audit({
            actor: ctx.userId,
            action: 'npm publish',
            access: 'pipelines:execute',
            status: 200,
            detail: `${ctx.repo}: published ${name}`,
          });

          const trust = await sh(
            `npm trust github ${name} --file ${cfg.workflowFile} --repo ${ctx.repo} --allow-publish -y`,
            env,
          );
          if (trust.exitCode !== 0) {
            return { status: 'failed', summary: `${name} published but trust registration failed`, detail: trust.output };
          }

          // Exit codes are not proof. Publish succeeding while trust silently
          // failed is the state that must never reach a merge.
          const view = await sh(`npm view ${name} version`, env);
          if (view.exitCode !== 0 || !view.output.trim()) {
            return { status: 'failed', summary: `${name} is still absent from npm after publish` };
          }
          const listed = await sh(`npm trust list ${name} --json`, env);
          if (!listed.output.includes(ctx.repo) || !listed.output.includes(cfg.workflowFile)) {
            return {
              status: 'failed',
              summary: `could not confirm the trusted publisher for ${name}; fix before merging`,
              detail: listed.output,
            };
          }
          notes.push(`${name}@${view.output.trim()} published and trusted`);
        }

        const recheck = await sh(cfg.detectCommand);
        const left = firstCapture(recheck.output, cfg.countPattern);
        if (left !== '0') {
          return {
            status: 'failed',
            summary: `detector still reports ${left ?? 'an unknown number of'} package(s) needing bootstrap`,
            detail: recheck.output,
          };
        }
        return { status: 'passed', summary: notes.join('; '), detail: notes.join('\n'), outputs };
      };

      return ctx.pr
        ? deps.checkouts.withPullRequestWorktree(
            ctx.repo,
            `bootstrap-${ctx.pr.number}-${randomUUID().slice(0, 8)}`,
            ctx.pr.number,
            ctx.pr.baseRef,
            work,
            undefined,
            ctx.userId,
          )
        : work(deps.checkouts.cloneDir(ctx.repo));
    },

    'pr-state-gate': async (step, ctx) => {
      if (!ctx.pr) return { status: 'error', summary: 'PR state gate only applies to PR pipelines' };
      const client = deps.github({ repo: ctx.repo, username: ctx.userId });
      if (!client) return { status: 'error', summary: 'GitHub is not configured' };

      // Merged first. A merged PR reports mergeable UNKNOWN forever, so asking
      // about mergeability before merged-ness produces a misleading failure.
      const fresh = await client.pull(ctx.repo, ctx.pr.number);
      if (fresh.merged_at) {
        return { status: 'failed', summary: `#${ctx.pr.number} is already merged`, outputs: { state: 'merged' } };
      }
      if (fresh.state === 'closed') {
        return { status: 'failed', summary: `#${ctx.pr.number} is closed`, outputs: { state: 'closed' } };
      }
      if (step.config.requireReady && fresh.draft === true) {
        return {
          status: 'failed',
          summary: 'PR is still a draft',
          outputs: { state: 'draft' },
          remedies: [{ action: 'pr.mark-ready', label: 'Mark ready for review' }],
        };
      }

      const mergeState = fresh.mergeable_state ?? 'unknown';
      deps.store.prs.setMergeable(ctx.repo, ctx.pr.number, fresh.mergeable ?? null, mergeState);
      const outputs = {
        state: mergeState,
        mergeable: String(fresh.mergeable ?? 'unknown'),
        headSha: fresh.head.sha,
      };

      if (fresh.mergeable === false || mergeState === 'dirty') {
        return {
          status: 'failed',
          summary: `conflicts with ${fresh.base.ref}`,
          outputs,
          remedies: [{ action: 'pr.resolve-conflicts', label: 'Resolve conflicts with an agent' }],
        };
      }
      if (fresh.mergeable === null || fresh.mergeable === undefined) {
        // GitHub computes this lazily in the background.
        return { status: 'failed', summary: 'GitHub is still computing mergeability; re-run shortly', outputs };
      }

      if (step.config.requireApproved) {
        const decision = foldReviewDecision(await client.prReviewList(ctx.repo, ctx.pr.number));
        if (decision !== 'approved') {
          return {
            status: 'failed',
            summary: `no human approval (${decision ?? 'none'})`,
            outputs,
            // Changes requested is answerable; a plain absence of review is not
            // something this instance can fix for you.
            remedies:
              decision === 'changes_requested'
                ? [{ action: 'pr.address-reviews', label: 'Address the feedback with an agent' }]
                : [],
          };
        }
      }

      if (mergeState === 'behind' && step.config.requireUpToDate) {
        const protection = await client.branchProtection(ctx.repo, fresh.base.ref);
        // `behind` only blocks when the base insists on up-to-date branches.
        // Unreadable protection is not proof it is absent, so it blocks too.
        if (protection === null || protection.strict) {
          return {
            status: 'failed',
            summary: `behind ${fresh.base.ref} and that base ${protection === null ? 'may require' : 'requires'} up-to-date branches`,
            outputs,
            remedies: [{ action: 'pr.update-branch', label: `Merge ${fresh.base.ref} into the branch` }],
          };
        }
      }
      if (mergeState === 'blocked') {
        return { status: 'failed', summary: 'blocked by a required check or review', outputs };
      }
      return { status: 'passed', summary: `mergeable (${mergeState})`, outputs };
    },

    'pr-action': async (step, ctx) => {
      if (!ctx.pr) return { status: 'error', summary: 'PR actions only apply to PR pipelines' };
      const client = deps.github({ repo: ctx.repo, username: ctx.userId });
      if (!client) return { status: 'error', summary: 'GitHub is not configured' };
      const { pr, repo, userId } = ctx;
      const run = async (): Promise<string> => {
        switch (step.config.action) {
          case 'pr.rerun-failed':
          case 'pr.rerun-all': {
            if (!pr.headSha) throw new Error('no known head commit');
            const scope = step.config.action === 'pr.rerun-all' ? 'all' : 'failed';
            const n = await client.rerunChecks(repo, pr.headSha, scope);
            return n === 0 ? 'nothing to re-run' : `restarted ${n} workflow run(s)`;
          }
          case 'pr.mark-ready':
            await client.markReadyForReview(repo, pr.number);
            return 'marked ready for review';
          case 'pr.update-branch':
            await client.updateBranch(repo, pr.number);
            return `merged ${pr.baseRef} into the branch`;
          case 'pr.fix-checks':
            return `repair agent queued (run ${(await deps.fixes.startCheckFix(repo, pr.number, userId)).id})`;
          case 'pr.resolve-conflicts':
            return `conflict resolver queued (run ${(await deps.fixes.startConflictResolve(repo, pr.number, userId)).id})`;
          case 'pr.address-reviews':
            return `review-fix agent queued (run ${(await deps.fixes.startReviewFix(repo, pr.number, userId)).id})`;
          case 'pr.analyze-checks':
            await deps.reviews.analyzeFailedChecks(repo, pr.number, userId);
            return 'CI analysis written';
        }
      };
      try {
        return { status: 'passed', summary: await run(), outputs: { action: step.config.action } };
      } catch (err) {
        return { status: 'failed', summary: `${step.config.action} failed: ${String(err)}` };
      }
    },

    merge: async (step, ctx) => {
      if (!ctx.pr) return { status: 'error', summary: 'merge only applies to PR pipelines' };
      const client = deps.github({ repo: ctx.repo, username: ctx.userId });
      if (!client) return { status: 'error', summary: 'GitHub is not configured' };

      if (step.config.requirePinnedHead && ctx.pinnedHeadSha) {
        const fresh = await client.pull(ctx.repo, ctx.pr.number);
        if (fresh.head.sha !== ctx.pinnedHeadSha) {
          // Everything above this step judged the pinned commit. Merging a
          // different one would merge something no gate ever saw.
          return {
            status: 'failed',
            summary: `head moved ${ctx.pinnedHeadSha.slice(0, 8)} → ${fresh.head.sha.slice(0, 8)} during this run; re-run`,
          };
        }
      }

      const result = await client.mergePr(ctx.repo, ctx.pr.number, step.config.method);
      if (!result.merged) {
        return { status: 'failed', summary: result.message || 'GitHub refused the merge' };
      }
      deps.audit({
        actor: ctx.userId,
        action: 'pipeline merge',
        access: 'prs:act',
        status: 200,
        detail: `${ctx.repo}#${ctx.pr.number} merged (${step.config.method}) at ${ctx.pinnedHeadSha ?? 'unpinned'}`,
      });
      let branch = '';
      if (step.config.deleteBranch) {
        const deleted = await client.deleteMergedPrBranch(ctx.repo, ctx.pr.number).catch(() => false);
        branch = deleted ? ', branch deleted' : ', branch left (fork or already gone)';
      }
      return {
        status: 'passed',
        summary: `merged with ${step.config.method}${branch}`,
        outputs: { merged: 'true', method: step.config.method },
      };
    },
  };
}

/**
 * Verified 2026-07-31 against npm 11.16 and pnpm 10.30 by observing the
 * outgoing Authorization header: npm, pnpm publish and npm trust all honour
 * this. The name is not assignable by a shell, which is fine because it is
 * passed through the spawn env object, never through a command line.
 */
const NPM_AUTH_ENV = 'NPM_CONFIG_//registry.npmjs.org/:_authToken';

/**
 * Drop hidden variables' storage keys on the way out of this instance.
 *
 * The key is a pointer into THIS instance's secret store, so exporting it would
 * be meaningless elsewhere and misleading here: it would look like the value
 * travelled with the document. The name survives so the import preview can say
 * which variables the recipient has to fill in.
 */
function stripSecretKeys(step: PipelineStep): PipelineStep {
  if (step.kind === 'npm-bootstrap') {
    return { ...step, config: { ...step.config, token: { name: step.config.token.name, hidden: true } } };
  }
  if (step.kind !== 'executable') return step;
  return {
    ...step,
    config: {
      ...step.config,
      variables: step.config.variables.map((v) => (v.hidden ? { name: v.name, hidden: true } : v)),
    },
  };
}

/** A name that is safe to interpolate into a shell command. */
const SAFE_PACKAGE_NAME = /^@?[a-z0-9][\w.-]*(\/[a-z0-9][\w.-]*)?$/i;

/** `@scope/pkg@1.2.3` → `@scope/pkg`: only the trailing @version comes off. */
function stripVersion(spec: string): string {
  const at = spec.lastIndexOf('@');
  return at > 0 ? spec.slice(0, at) : spec;
}

function firstCapture(text: string, pattern: string): string | null {
  try {
    const m = new RegExp(pattern, 'm').exec(text);
    return m ? (m[1] ?? m[0]) : null;
  } catch {
    return null;
  }
}

/**
 * Narrow output to one heading's section: from the line matching `pattern` to
 * the next heading line. Mirrors the shell original's awk range, including the
 * reason it is a range to the next HEADING and not to the next blank line: a
 * renderer that puts a blank line between a heading and its list would
 * otherwise capture the heading alone and read as an empty section.
 */
function section(text: string, pattern: string | undefined): string {
  if (!pattern) return text;
  const lines = text.split('\n');
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    return text;
  }
  const start = lines.findIndex((l) => re.test(l));
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

function allCaptures(text: string, pattern: string): string[] {
  try {
    return [...text.matchAll(new RegExp(pattern, 'gm'))].map((m) => m[1] ?? m[0]);
  } catch {
    return [];
  }
}

/** Long on purpose: a confirmation request is a question to a person, and
 *  "after lunch" is a normal answer. Bounded so a forgotten run frees its slot. */
const APPROVAL_TIMEOUT_MS = 12 * 60 * 60_000;

/** A command that regenerates inventories prints far more than a verify does. */
const EXECUTABLE_MAX_OUTPUT = 200_000;

/** Credential shapes worth catching even when they came from somewhere else. */
const CREDENTIAL_PATTERNS = [
  /(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g,
  /npm_[A-Za-z0-9]{36,}/g,
  /\/\/[^/@\s]+:[^/@\s]+@/g,
];

/**
 * Scrub command output before it is persisted or broadcast.
 *
 * `injected` comes first and is the part that actually matters: redacting the
 * exact values this step put in the environment is complete, where pattern
 * matching is only ever a guess about someone else's format.
 */
export function redact(text: string, injected: readonly string[]): string {
  let out = text;
  for (const value of injected) {
    // A short or empty value would turn the whole output into asterisks.
    if (value.length < 8) continue;
    out = out.replaceAll(value, '***');
  }
  for (const re of CREDENTIAL_PATTERNS) out = out.replace(re, '***');
  return out;
}

/**
 * Scrub a stream, not a string.
 *
 * Running `redact` per chunk is not enough: a credential split across two
 * chunks matches neither half, and streams split wherever the pipe happens to
 * flush. So the tail that could still be the beginning of a secret is held
 * back and re-examined once the next chunk supplies the rest.
 *
 * The held-back window is the longest injected value, which is what bounds how
 * far a match could straddle. `flush` emits whatever is left when the command
 * ends, scrubbed.
 */
export function chunkScrubber(injected: readonly string[]): {
  push(chunk: string): string;
  flush(): string;
} {
  // 64 covers the credential PATTERNS too, which redact applies regardless of
  // what this step injected.
  const window = Math.max(64, ...injected.map((v) => v.length));
  let carry = '';
  return {
    push(chunk) {
      const buf = carry + chunk;
      const keep = Math.min(window - 1, buf.length);
      // Slice the RAW buffer, then redact: redaction changes length, so an
      // index computed before it cannot be applied after it.
      carry = buf.slice(buf.length - keep);
      return redact(buf.slice(0, buf.length - keep), injected);
    },
    flush() {
      const out = redact(carry, injected);
      carry = '';
      return out;
    },
  };
}

/** Named outputs pulled out of a command's text. A miss yields no key at all. */
function capture(
  specs: ReadonlyArray<{ name: string; pattern: string }> | undefined,
  output: string,
): Record<string, string> | undefined {
  if (!specs?.length) return undefined;
  const out: Record<string, string> = {};
  for (const { name, pattern } of specs) {
    try {
      const m = new RegExp(pattern, 'm').exec(output);
      if (m) out[name] = m[1] ?? m[0];
    } catch {
      // An unparseable pattern is the author's bug, not a reason to fail the
      // command that already ran and succeeded.
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
  /**
   * Runs paused at a confirmation gate: key `<runId>:<stepIndex>` → the resolver
   * that lets it continue. In memory on purpose. A pending approval is a person
   * being asked a question right now, and a daemon that restarts has lost the
   * conversation, not just the timer — the boot sweep marks such runs
   * interrupted rather than silently resuming something nobody re-confirmed.
   */
  private readonly awaiting = new Map<string, (approved: boolean) => void>();

  constructor(
    private readonly deps: EngineDeps,
    private readonly broadcast: (msg: SpaServerMessage) => void,
  ) {
    this.registry = createStepRegistry(deps, broadcast);
    const swept = deps.store.pipelines.markInterruptedRuns();
    if (swept > 0) log.info(`marked ${swept} pipeline run(s) interrupted from previous daemon life`);
  }

  // ---------- definitions CRUD ---------------------------------------------------

  list(workspaceId: string): PipelineRecord[] {
    return this.deps.store.pipelines.list(workspaceId);
  }

  create(workspaceId: string, input: z.infer<typeof savePipelineSchema>, author: string): PipelineRecord {
    const now = Date.now();
    const record: PipelineRecord = {
      id: `pl-${randomUUID().slice(0, 12)}`,
      workspaceId,
      type: input.type,
      name: input.name,
      description: input.description,
      steps: this.stashAll(input.steps as PipelineStepSpec[], workspaceId, author),
      autoRunOnPrOpen: input.autoRunOnPrOpen,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.store.pipelines.insert(record);
    this.collectSecrets();
    this.broadcast({ t: 'pipelines.changed' });
    return record;
  }

  update(id: string, input: Partial<z.infer<typeof savePipelineSchema>>, author: string): PipelineRecord {
    const existing = this.deps.store.pipelines.get(id);
    if (!existing) throw new Error(`unknown pipeline ${id}`);
    this.deps.store.pipelines.update(id, {
      type: input.type,
      name: input.name,
      description: input.description,
      steps: input.steps ? this.stashAll(input.steps as PipelineStepSpec[], existing.workspaceId, author) : undefined,
      autoRunOnPrOpen: input.autoRunOnPrOpen,
    });
    this.collectSecrets();
    this.broadcast({ t: 'pipelines.changed' });
    return this.deps.store.pipelines.get(id)!;
  }

  remove(id: string): void {
    this.deps.store.pipelines.delete(id);
    this.collectSecrets();
    this.broadcast({ t: 'pipelines.changed' });
  }

  // ---------- step library CRUD ----------------------------------------------------

  listStepDefinitions(workspaceId: string): StepDefinitionRecord[] {
    return this.deps.store.pipelines.listStepDefinitions(workspaceId);
  }

  createStepDefinition(
    workspaceId: string,
    input: z.infer<typeof saveStepDefinitionSchema>,
    author: string,
  ): StepDefinitionRecord {
    const now = Date.now();
    const record: StepDefinitionRecord = {
      id: `sd-${randomUUID().slice(0, 12)}`,
      workspaceId,
      name: input.name,
      description: input.description,
      step: this.stashSecrets({ ...(input.step as PipelineStep), name: input.name }, workspaceId, author),
      createdAt: now,
      updatedAt: now,
    };
    this.deps.store.pipelines.insertStepDefinition(record);
    this.collectSecrets();
    this.broadcast({ t: 'pipelines.changed' });
    return record;
  }

  updateStepDefinition(
    id: string,
    input: Partial<z.infer<typeof saveStepDefinitionSchema>>,
    author: string,
  ): StepDefinitionRecord {
    const existing = this.deps.store.pipelines.getStepDefinition(id);
    if (!existing) throw new Error(`unknown step definition ${id}`);
    this.deps.store.pipelines.updateStepDefinition(id, {
      name: input.name,
      description: input.description,
      step: input.step
        ? this.stashSecrets(
            { ...(input.step as PipelineStep), name: input.name ?? existing.name },
            existing.workspaceId,
            author,
          )
        : undefined,
    });
    this.collectSecrets();
    this.broadcast({ t: 'pipelines.changed' });
    return this.deps.store.pipelines.getStepDefinition(id)!;
  }

  removeStepDefinition(id: string): void {
    this.deps.store.pipelines.deleteStepDefinition(id);
    this.collectSecrets();
    this.broadcast({ t: 'pipelines.changed' });
  }

  // ---------- hidden step variables --------------------------------------------------

  /**
   * Move every hidden variable's value into the secret store, leaving only its
   * key on the step. Runs on every write path, so a value is in the definition
   * for exactly as long as it takes to persist it.
   *
   * A hidden variable arriving with no value keeps whatever key it already had:
   * that is the editor round-tripping an untouched field, not a request to clear
   * it, exactly like an untouched password input.
   */
  private stashSecrets(step: PipelineStep, workspaceId: string, author: string): PipelineStep {
    if (step.kind === 'npm-bootstrap') {
      const [token] = this.stashVariables([step.config.token], workspaceId, author);
      return { ...step, config: { ...step.config, token: token! } };
    }
    if (step.kind !== 'executable') return step;
    return {
      ...step,
      config: { ...step.config, variables: this.stashVariables(step.config.variables, workspaceId, author) },
    };
  }

  private stashVariables(
    input: ReadonlyArray<StepVariable>,
    workspaceId: string,
    author: string,
  ): StepVariable[] {
    return input.map((v): StepVariable => {
      if (!v.hidden) return { name: v.name, hidden: false, value: v.value ?? '' };
      const supplying = v.value !== undefined && v.value !== '';
      const existing = v.secretKey ? this.deps.store.pipelineSecrets.get(v.secretKey) : undefined;

      // Editing a step that carries someone else's credential is the
      // exfiltration path: change the command, keep the variable, read the value
      // out. Redaction does not stop that, so ownership does. Supplying your own
      // value is always allowed, and makes you the owner.
      if (existing && existing.ownerId !== author && !supplying) {
        throw new Error(
          `"${v.name}" holds ${existing.ownerId}'s value; replace it with your own to edit this step`,
        );
      }

      const key = v.secretKey ?? randomUUID();
      if (supplying) this.deps.secrets.set(key, v.value!);
      this.deps.store.pipelineSecrets.upsert({
        key,
        workspaceId,
        // Ownership follows whoever last supplied a value, not whoever last
        // saved the step: editing a name must not silently reassign a credential.
        ownerId: supplying ? author : (existing?.ownerId ?? author),
        visibility: v.visibility ?? existing?.visibility ?? 'private',
      });
      const meta = this.deps.store.pipelineSecrets.get(key);
      return {
        name: v.name,
        hidden: true,
        secretKey: key,
        visibility: meta?.visibility ?? 'private',
        ownerId: meta?.ownerId ?? author,
      };
    });
  }

  private stashAll(specs: ReadonlyArray<PipelineStepSpec>, workspaceId: string, author: string): PipelineStepSpec[] {
    return specs.map((s) =>
      s.type === 'inline' ? { ...s, step: this.stashSecrets(s.step, workspaceId, author) } : s,
    );
  }

  /**
   * Delete stored secrets no surviving step references any more.
   *
   * Runs after every write and delete. Without it, editing a variable away or
   * deleting its pipeline would leave the value in the store forever, which is
   * the one direction a secret must never drift.
   */
  private collectSecrets(): void {
    const live = new Set<string>();
    const walk = (step: PipelineStep): void => {
      if (step.kind === 'npm-bootstrap') {
        if (step.config.token.secretKey) live.add(step.config.token.secretKey);
        return;
      }
      if (step.kind !== 'executable') return;
      for (const v of step.config.variables) if (v.secretKey) live.add(v.secretKey);
    };
    for (const workspaceId of this.deps.store.pipelines.workspaceIds()) {
      for (const p of this.deps.store.pipelines.list(workspaceId)) {
        for (const spec of p.steps) if (spec.type === 'inline') walk(spec.step);
      }
      for (const d of this.deps.store.pipelines.listStepDefinitions(workspaceId)) walk(d.step);
    }
    // Every key here is one this module minted, so an unreferenced one is
    // unambiguously ours to drop.
    for (const key of this.deps.secrets.keys()) {
      if (!live.has(key)) {
        this.deps.secrets.delete(key);
        this.deps.store.pipelineSecrets.delete(key);
      }
    }
  }

  // ---------- export / import ------------------------------------------------------

  exportPipeline(id: string): PipelineExport {
    const pipeline = this.deps.store.pipelines.get(id);
    if (!pipeline) throw new Error(`unknown pipeline ${id}`);
    const resolved = this.resolveSteps(pipeline.steps, pipeline.type);
    const broken = resolved.filter((r) => !r.ok);
    if (broken.length > 0) {
      // Exporting a pipeline whose library refs no longer resolve would produce
      // a document that silently imports with steps missing.
      const reasons = broken.map((b) => (b as Extract<ResolvedStep, { ok: false }>).reason);
      throw new Error(`cannot export "${pipeline.name}": ${reasons.join('; ')}`);
    }
    return {
      version: PIPELINE_EXPORT_VERSION,
      exportedAt: Date.now(),
      pipeline: {
        type: pipeline.type,
        name: pipeline.name,
        description: pipeline.description,
        steps: resolved.map((r) => stripSecretKeys((r as Extract<ResolvedStep, { ok: true }>).step)),
        autoRunOnPrOpen: pipeline.autoRunOnPrOpen,
      },
    };
  }

  /** Parse and describe an import without writing anything. */
  previewImport(payload: unknown): ImportPreview {
    const doc = pipelineExportSchema.parse(payload);
    const steps = doc.pipeline.steps as PipelineStep[];
    const executables: ImportedExecutableStep[] = [];
    for (const step of steps) {
      if (step.kind === 'executable') {
        executables.push({
          name: step.name,
          kind: step.kind,
          command: step.config.command,
          // Names, not keys: an imported document carries no values, so what the
          // reader needs is which variables they will have to fill in here.
          secretKeys: step.config.variables.filter((v) => v.hidden).map((v) => v.name),
        });
      } else if (step.kind === 'npm-bootstrap') {
        executables.push({
          name: step.name,
          kind: step.kind,
          command: step.config.detectCommand,
          secretKeys: [step.config.token.name],
        });
      }
    }
    return {
      name: doc.pipeline.name,
      type: doc.pipeline.type,
      description: doc.pipeline.description,
      stepCount: steps.length,
      executables,
      requiredSecrets: [...new Set(executables.flatMap((e) => e.secretKeys))],
    };
  }

  /**
   * Create a pipeline from an exported document.
   *
   * Executable steps do NOT block the import: creating a definition is not
   * running one, and execution is already gated twice (the `pipelines:execute`
   * permission and the instance switch). What they do require is that the caller
   * saw them, which is what `acknowledgedExecutables` records.
   */
  importPipeline(
    workspaceId: string,
    payload: unknown,
    acknowledgedExecutables: boolean,
    author: string,
  ): PipelineRecord {
    const preview = this.previewImport(payload);
    if (preview.executables.length > 0 && !acknowledgedExecutables) {
      throw new Error(
        `this pipeline contains ${preview.executables.length} step(s) that run commands; review them and confirm`,
      );
    }
    const doc = pipelineExportSchema.parse(payload);
    return this.create(
      workspaceId,
      {
      type: doc.pipeline.type,
      name: doc.pipeline.name,
      description: doc.pipeline.description,
      steps: doc.pipeline.steps.map((step) => ({ type: 'inline' as const, step })),
      autoRunOnPrOpen: doc.pipeline.autoRunOnPrOpen,
      },
      author,
    );
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
    /** Whether the caller holds `pipelines:execute`. Absent means no. */
    allowExecutable = false,
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

    void this.execute(run.id, resolved, {
      repo,
      userId,
      type: pipeline.type,
      pr,
      issue,
      allowExecutable,
      pinnedHeadSha: pr?.headSha ?? null,
      workspaceId: pipeline.workspaceId,
    }).catch((err) => {
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

  /** Never passes allowExecutable: a GitHub push must not reach a shell. */
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

  private async execute(
    runId: string,
    resolved: ResolvedStep[],
    ctx: Omit<StepContext, 'completed' | 'runId' | 'stepIndex'>,
  ): Promise<void> {
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

      // Not for this run: recorded as skipped, and the pipeline carries on
      // regardless of onFailure, because an unmet condition is not a failure.
      if (!conditionMet(step.when, steps.slice(0, i))) {
        steps[i] = {
          ...steps[i]!,
          status: 'skipped',
          summary: `condition not met (${step.when!.step}.${step.when!.output})`,
          finishedAt: Date.now(),
        };
        save();
        continue;
      }

      if (step.requiresApproval) {
        steps[i] = { ...steps[i]!, status: 'awaiting', summary: 'waiting for your confirmation', startedAt: Date.now() };
        save();
        const approved = await this.waitForApproval(runId, i);
        if (!approved) {
          steps[i] = { ...steps[i]!, status: 'skipped', summary: 'not confirmed', finishedAt: Date.now() };
          save();
          // Declining an irreversible step is a decision, not a fault, so it
          // halts the rest rather than failing the run.
          halted = true;
          continue;
        }
      }

      steps[i] = { ...steps[i]!, status: 'running', summary: null, startedAt: Date.now() };
      save();

      let outcome: StepOutcome;
      try {
        // Only the steps before this one: a step must not read its own slot,
        // which is still the `running` placeholder at this point.
        outcome = await this.runStep(step, { ...ctx, completed: steps.slice(0, i), runId, stepIndex: i });
      } catch (err) {
        outcome = { status: 'error', summary: String(err) };
      }
      steps[i] = {
        ...steps[i]!,
        status: outcome.status,
        summary: outcome.summary,
        detail: outcome.detail ?? null,
        outputs: outcome.outputs,
        remedies: outcome.remedies,
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

  /**
   * Block until someone answers, or until the ceiling. The ceiling exists so a
   * forgotten pipeline eventually stops holding a runner slot and a promise; it
   * is deliberately long, because "I will look at this after lunch" is a normal
   * answer to a confirmation request.
   */
  private waitForApproval(runId: string, stepIndex: number): Promise<boolean> {
    const key = `${runId}:${stepIndex}`;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.awaiting.delete(key);
        resolve(false);
      }, APPROVAL_TIMEOUT_MS);
      timer.unref();
      this.awaiting.set(key, (approved) => {
        clearTimeout(timer);
        this.awaiting.delete(key);
        resolve(approved);
      });
    });
  }

  /** Answer a confirmation gate. False when nothing is waiting there. */
  resolveApproval(runId: string, stepIndex: number, approved: boolean): boolean {
    const pending = this.awaiting.get(`${runId}:${stepIndex}`);
    if (!pending) return false;
    pending(approved);
    return true;
  }

  private runStep(step: PipelineStep, ctx: StepContext): Promise<StepOutcome> {
    const handler = this.registry[step.kind] as (s: PipelineStep, c: StepContext) => Promise<StepOutcome>;
    return handler(step, ctx);
  }
}

function pendingResult(name: string, kind: PipelineStepResult['kind']): PipelineStepResult {
  return { name, kind, status: 'pending', summary: null, detail: null, startedAt: null, finishedAt: null };
}
