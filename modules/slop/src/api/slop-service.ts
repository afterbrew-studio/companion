import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import type { ServiceMap, SpaServerMessage, BusEvents } from '@moxxy/companion-contracts';
import { log, paths } from '@moxxy/companion-sdk/server';
import { extractModelJson } from '@moxxy/companion-sdk/agents';
import type { PrRecord } from '@companion/module-code/contract';
import type {
  SlopAction,
  SlopMoveToRefinementResult,
  SlopDetectionResult,
  SlopRuleDraft,
  SlopRuleRecord,
  SlopSignal,
  SlopVerdict,
} from '../contract/index.js';
import type { SlopStore } from './slop-store.js';
import { BUILTIN_RULES } from './builtin-rules.js';

// Structural aliases, operate-types style: another module's /api entry must
// never be imported, so the collaborator types derive from the service bundles
// this module receives through the registry.
type CodeService = ServiceMap['code'];
type Orchestrator = ServiceMap['operate']['orchestrator'];
type Checkouts = ServiceMap['operate']['checkouts'];
type RefinementService = ServiceMap['refinement'];
type GitHubClient = NonNullable<ReturnType<CodeService['githubAccounts']['clientFor']>>;

const DETECT_TIMEOUT_MS = 15 * 60_000;
const GENERATE_RULE_TIMEOUT_MS = 5 * 60_000;

// Limits mirror the save-rule route schema; the prompt asks for less so an
// enthusiastic model still lands inside them.
const ruleDraftSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300),
  instructions: z.string().trim().min(8).max(8_000),
});

const verdictSchema = z.object({
  aiLikelihood: z.number().int().min(0).max(100),
  confidence: z.enum(['low', 'medium', 'high']),
  summary: z.string().min(1),
  signals: z
    .array(
      z.object({
        ruleId: z.string(),
        observation: z.string(),
        strength: z.enum(['weak', 'moderate', 'strong']),
      }),
    )
    .max(20),
  recommendedAction: z.enum(['none', 'label', 'comment', 'request_changes', 'close']),
  reviewerHints: z.array(z.string().min(1)).max(10).default([]),
  draftComment: z.string(),
});

/**
 * AI Slop Detection, review-then-apply like triage: ONE one-shot read-only
 * agent scores a PR (from code's sync cache) against the workspace's enabled
 * rule set and stores a pending verdict; labeling / commenting / requesting
 * changes / closing only happens on explicit, permissioned human apply.
 */
export class SlopService {
  constructor(
    private readonly store: SlopStore,
    private readonly code: CodeService,
    private readonly orchestrator: Orchestrator,
    private readonly checkouts: Checkouts,
    private readonly github: (ctx?: { repo?: string; accountId?: string; username?: string | null }) => GitHubClient | null,
    private readonly refinement: () => RefinementService | undefined,
    /** The label the 'label' action applies — module config, read live. */
    private readonly slopLabel: () => string,
    private readonly broadcast: (msg: SpaServerMessage) => void,
    private readonly emit: <K extends keyof BusEvents & string>(event: K, payload: BusEvents[K]) => void,
  ) {}

  /** The workspace a repo belongs to — via code's repos store (the scoping key). */
  private workspaceOf(repo: string): string | null {
    return this.code.repos.get(repo)?.workspace_id ?? null;
  }

  // ---------- rules -----------------------------------------------------------------

  /** Built-ins (with this workspace's toggles applied) + the workspace's custom rules. */
  rules(workspaceId: string): SlopRuleRecord[] {
    const disabled = this.store.disabledBuiltins(workspaceId);
    return [
      ...BUILTIN_RULES.map((rule) => (disabled.has(rule.id) ? { ...rule, enabled: false } : rule)),
      ...this.store.listRules(workspaceId),
    ];
  }

  saveRule(
    workspaceId: string,
    fields: { name: string; description: string; instructions: string },
  ): SlopRuleRecord {
    const now = Date.now();
    const rule: SlopRuleRecord & { workspaceId: string } = {
      id: `sr-${randomUUID().slice(0, 12)}`,
      workspaceId,
      name: fields.name,
      description: fields.description,
      instructions: fields.instructions,
      builtin: false,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    this.store.insertRule(rule);
    this.changed();
    return rule;
  }

  updateRule(
    id: string,
    fields: { name?: string; description?: string; instructions?: string },
  ): SlopRuleRecord {
    if (id.startsWith('builtin-')) throw new Error('built-in rules cannot be edited — disable them instead');
    if (!this.store.getRule(id)) throw new Error('rule not found');
    this.store.updateRule(id, fields);
    this.changed();
    return this.store.getRule(id)!;
  }

  deleteRule(id: string): void {
    if (id.startsWith('builtin-')) throw new Error('built-in rules cannot be deleted');
    if (this.store.deleteRule(id)) this.changed();
  }

  /** Enable/disable a rule for a workspace — built-ins via toggle rows, custom via the column. */
  setRuleEnabled(workspaceId: string, id: string, enabled: boolean): void {
    if (id.startsWith('builtin-')) {
      if (!BUILTIN_RULES.some((rule) => rule.id === id)) throw new Error('unknown built-in rule');
      this.store.setBuiltinEnabled(workspaceId, id, enabled);
    } else {
      const rule = this.store.getRule(id);
      if (!rule || rule.workspaceId !== workspaceId) throw new Error('rule not found');
      this.store.setRuleEnabled(id, enabled);
    }
    this.changed();
  }

  /** A user-defined rule row (built-ins have no row) — for route access gating. */
  customRule(id: string): SlopRuleRecord | undefined {
    return this.store.getRule(id);
  }

  /**
   * Draft a detection rule from a free-form request (a tell the team keeps
   * seeing, a policy to enforce) with a one-shot agent — no repo context,
   * detection craft only. Returns the draft for review; the caller saves it
   * (or not) through {@link saveRule}.
   */
  async generateRule(prompt: string): Promise<SlopRuleDraft> {
    const { finalMessage } = await this.orchestrator.runOneShot({
      kind: 'analysis',
      task: 'slop.detect',
      title: `Draft slop rule: ${prompt.replace(/\s+/g, ' ').slice(0, 60)}`,
      // No repo to ground in — the orchestrator mkdirs whatever cwd it gets.
      cwd: join(paths.scratch(), 'slop-rules'),
      prompt: generateRulePrompt(prompt),
      timeoutMs: GENERATE_RULE_TIMEOUT_MS,
    });
    // null = timeout or dead runner — say so instead of letting the JSON
    // extractor choke on an empty string with a cryptic parse error.
    if (finalMessage === null) throw new Error('the agent run ended without a reply (timeout or runner failure) — try again');
    return ruleDraftSchema.parse(extractModelJson(finalMessage));
  }

  // ---------- detection -------------------------------------------------------------

  /**
   * Cheap synchronous validation, shared by the route (so a bad request 400s
   * instead of vanishing into fire-and-forget) and the agent phase.
   */
  private prepare(
    repo: string,
    prNumber: number,
    userId: string,
  ): { pr: PrRecord; ruleSet: SlopRuleRecord[] } {
    const pr = this.code.prs.get(repo, prNumber);
    if (!pr) throw new Error(`unknown PR ${repo}#${prNumber}`);
    const workspaceId = this.workspaceOf(repo);
    if (!workspaceId) throw new Error(`repo ${repo} is not connected`);
    const ruleSet = this.rules(workspaceId).filter((rule) => rule.enabled);
    if (ruleSet.length === 0) throw new Error('no detection rules are enabled for this workspace');
    if (!this.github({ repo, username: userId })) throw new Error('your GitHub accounts cannot access this repository');
    if (!this.checkouts.hasClone(repo)) throw new Error(`repo ${repo} has no clone yet`);
    return { pr, ruleSet };
  }

  /** Throws when a detection cannot start (unknown PR, empty rule set, no clone…). */
  validateDetect(repo: string, prNumber: number, userId: string): void {
    this.prepare(repo, prNumber, userId);
  }

  /**
   * Boot recovery: fail any 'running' row stranded by the previous process.
   * Runs before the resumer registers, so a replayed detection's fresh row
   * never gets swept up with the orphans.
   */
  recoverInterrupted(): void {
    if (this.store.failInterrupted() > 0) this.changed();
  }

  /**
   * Run one detection for a PR. The PR record comes from code's sync cache
   * (GitHub-as-cache). The agent receives a temporary checkout at the exact PR
   * head and inspects the complete diff locally in bounded file groups. A
   * 'running' row is stored (and broadcast) up front, then settled when the
   * agent phase resolves — a failure (checkout, dead run, parse miss) lands as
   * status 'failed', never a fabricated verdict and never a silent vanish.
   */
  async detect(repo: string, prNumber: number, userId: string): Promise<SlopDetectionResult> {
    const { pr, ruleSet } = this.prepare(repo, prNumber, userId);

    // The row exists (and broadcasts) BEFORE the minutes-long agent phase, so
    // the page shows a live 'running' card the moment a detection is queued.
    const placeholder: SlopDetectionResult = {
      id: `slop-${randomUUID().slice(0, 12)}`,
      repo,
      prNumber,
      prTitle: pr.title,
      runId: '',
      status: 'running',
      verdict: null,
      error: null,
      appliedAction: null,
      ruleIds: ruleSet.map((rule) => rule.id),
      createdAt: Date.now(),
    };
    this.store.insertDetection(placeholder);
    this.changed();

    let runId = '';
    let verdict: SlopVerdict | null = null;
    let error: string | null = null;
    try {
      const oneShot = await this.checkouts.withPullRequestWorktree(
        repo,
        `slop-${placeholder.id}`,
        prNumber,
        pr.baseRef,
        (cwd) =>
          this.orchestrator.runOneShot({
            kind: 'analysis',
            task: 'slop.detect',
            title: `Slop check PR #${prNumber}: ${pr.title.slice(0, 60)}`,
            cwd,
            repo,
            userId,
            issueNumber: prNumber,
            prompt: detectionPrompt(pr, ruleSet),
            timeoutMs: DETECT_TIMEOUT_MS,
            resume: { type: 'slop-detect', args: { repo, number: prNumber, userId } },
          }),
        undefined,
        userId,
      );
      runId = oneShot.runId;
      verdict = parseSlopVerdict(oneShot.finalMessage ?? '', ruleSet);
    } catch (err) {
      error = String(err instanceof Error ? err.message : err).slice(0, 500);
      log.warn('slop detection failed', { repo, prNumber, err: String(err) });
    }

    const settled = this.store.finishDetection(placeholder.id, {
      runId,
      status: verdict ? 'pending' : 'failed',
      verdict,
      error,
    });
    this.changed();
    // A dismissal that raced the run wins — report the row as it actually is.
    if (!settled) return this.store.getDetection(placeholder.id) ?? placeholder;
    const result: SlopDetectionResult = {
      ...placeholder,
      runId,
      status: verdict ? 'pending' : 'failed',
      verdict,
      error,
    };
    if (verdict) {
      this.emit('slop.verdict', {
        repo,
        prNumber,
        aiLikelihood: verdict.aiLikelihood,
        recommendedAction: verdict.recommendedAction,
      });
    }
    return result;
  }

  /**
   * The pipeline `slop-check` step's entry (see code's engine seam): run a
   * fresh detection and return the gate-relevant slice. Throws on a failed
   * detection — the engine turns that into a step error.
   */
  async detectForGate(
    repo: string,
    prNumber: number,
    userId: string,
  ): Promise<{ aiLikelihood: number; confidence: string; summary: string; detail: string | null }> {
    const result = await this.detect(repo, prNumber, userId);
    if (!result.verdict) throw new Error(result.error ?? 'detection produced no verdict');
    return {
      aiLikelihood: result.verdict.aiLikelihood,
      confidence: result.verdict.confidence,
      summary: result.verdict.summary,
      detail: signalsMarkdown(result.verdict.signals) || null,
    };
  }

  // ---------- reads -----------------------------------------------------------------

  getDetection(id: string): SlopDetectionResult | undefined {
    return this.store.getDetection(id);
  }

  listByWorkspace(workspaceId: string): SlopDetectionResult[] {
    return this.store.listByWorkspace(workspaceId);
  }

  listForPr(repo: string, prNumber: number): SlopDetectionResult[] {
    return this.store.listForPr(repo, prNumber);
  }

  /** Newest detection for a PR — the seam the board can poll to flag its tasks. */
  latestForPr(repo: string, prNumber: number): SlopDetectionResult | undefined {
    return this.store.listForPr(repo, prNumber)[0];
  }

  // ---------- apply / dismiss -------------------------------------------------------

  /**
   * Apply a pending verdict to GitHub. `action` overrides the recommendation
   * (a human may downgrade a "close" to a "comment"); 'none' just acknowledges.
   * 'close' posts the draft comment first — a silent close is hostile.
   */
  async apply(
    id: string,
    opts: { action?: SlopAction; accountId?: string; userId: string },
  ): Promise<{ repo: string; number: number; action: SlopAction }> {
    const result = this.store.getDetection(id);
    if (!result?.verdict) throw new Error('detection not found or has no verdict');
    if (result.status !== 'pending') throw new Error(`detection is ${result.status}, not pending`);
    const action = opts.action ?? result.verdict.recommendedAction;

    if (action !== 'none') {
      const client = this.github({ repo: result.repo, accountId: opts.accountId, username: opts.userId });
      if (!client) throw new Error('GitHub is not configured');
      const hints = result.verdict.reviewerHints;
      const body =
        result.verdict.draftComment.trim() ||
        `This pull request scored ${result.verdict.aiLikelihood}/100 on AI-slop detection (${result.verdict.confidence} confidence). ${result.verdict.summary}` +
          (hints.length > 0 ? `\n\nSuggestions:\n${hints.map((h) => `- ${h}`).join('\n')}` : '');
      switch (action) {
        case 'label':
          await client.addLabels(result.repo, result.prNumber, [this.slopLabel()]);
          break;
        case 'comment':
          await client.comment(result.repo, result.prNumber, body);
          break;
        case 'request_changes':
          try {
            await client.createPrReview(result.repo, result.prNumber, { body, event: 'REQUEST_CHANGES' });
          } catch (err) {
            // GitHub rejects REQUEST_CHANGES from the PR's own author (422) —
            // the verdict is still worth publishing as a comment review.
            if ((err as { status?: number }).status === 422) {
              await client.createPrReview(result.repo, result.prNumber, { body, event: 'COMMENT' });
            } else {
              throw err;
            }
          }
          break;
        case 'close':
          await client.comment(result.repo, result.prNumber, body);
          await client.closePr(result.repo, result.prNumber);
          break;
      }
    }

    this.store.setDetectionStatus(id, 'applied', action);
    this.changed();
    return { repo: result.repo, number: result.prNumber, action };
  }

  /** Turn a rejected low-oversight PR into a clean refinement starting from
   *  its base branch. The detection stays as audit history and records that
   *  the human chose refinement instead of applying a GitHub-side action. */
  moveToRefinement(id: string, workspaceId: string): SlopMoveToRefinementResult {
    const result = this.store.getDetection(id);
    if (!result?.verdict) throw new Error('detection not found or has no verdict');
    if (result.status !== 'pending') throw new Error(`detection is ${result.status}, not pending`);
    const pr = this.code.prs.get(result.repo, result.prNumber);
    if (!pr) throw new Error('pull request is no longer available');
    const refinementService = this.refinement();
    if (!refinementService) throw new Error('Product Refinement is not enabled');

    const signalLines = result.verdict.signals.map(
      (signal) => `- **${signal.ruleName} (${signal.strength})** — ${signal.observation}`,
    );
    const hintLines = result.verdict.reviewerHints.map((hint) => `- ${hint}`);
    const story = [
      `Rework [PR #${pr.number}](${pr.url}) from a clean \`${pr.baseRef}\` base rather than building on the detected low-oversight implementation.`,
      pr.body.trim() ? `## Original pull request\n${pr.body.trim()}` : '',
      `## Slop detection\n${result.verdict.summary}`,
      signalLines.length > 0 ? `## Evidence\n${signalLines.join('\n')}` : '',
      hintLines.length > 0 ? `## Expected improvements\n${hintLines.join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 32_000);
    const refinement = refinementService.create({
      workspaceId,
      repo: result.repo,
      branch: pr.baseRef,
      title: `Rework: ${pr.title}`.slice(0, 200),
      story,
    });
    this.store.setDetectionStatus(id, 'applied', 'refinement');
    this.changed();
    return { refinementId: refinement.id };
  }

  dismiss(id: string): void {
    const result = this.store.getDetection(id);
    if (!result) throw new Error('detection not found');
    this.store.setDetectionStatus(id, 'dismissed', null);
    this.changed();
  }

  // ---------- plumbing --------------------------------------------------------------

  private changed(): void {
    this.broadcast({ t: 'slop.changed' });
  }
}

function detectionPrompt(pr: PrRecord, rules: readonly SlopRuleRecord[]): string {
  const ruleSections = rules
    .map((rule) => `### ${rule.id}: ${rule.name}\n${rule.instructions}`)
    .join('\n\n');
  return `You are an AI-slop detector assessing whether a GitHub pull request was substantially machine-generated with low human oversight. The exact pull request head is checked out in the current directory.

READ-ONLY RULES (mandatory): you may read files and search the codebase to verify claims (do referenced APIs, helpers, and dependencies exist?), but you must NOT modify, create, or delete any file and must NOT run any write command (no git commit/push, no installs). Your ONLY output is the final JSON verdict.

## Detection rules
Apply EVERY rule below. Each signal you report must cite the id of the rule that produced it.

${ruleSections}

## PR #${pr.number}: ${pr.title}
Author: ${pr.author} | Branch: ${pr.headRef} → ${pr.baseRef} | Draft: ${pr.draft ? 'yes' : 'no'} | Labels: ${pr.labels.join(', ') || '(none)'}

${pr.body || '(no description)'}

## Inspecting the complete PR
\`origin/${pr.baseRef}\` is the refreshed base. Inspect the complete change locally; no prompt-sized diff was provided.

- Start with \`git diff --stat origin/${pr.baseRef}...HEAD\`, \`git diff --numstat origin/${pr.baseRef}...HEAD\`, and \`git diff --name-only origin/${pr.baseRef}...HEAD\`.
- Inspect changed files in bounded groups with \`git diff origin/${pr.baseRef}...HEAD -- <path>...\`; do not dump an oversized whole-PR diff into one tool call.
- Cover every changed file and apply every enabled detection rule. Generated, vendored, lock, and binary files may be classified and sampled instead of expanded line-by-line.
- If collaboration/subagent tools are available, delegate disjoint file groups or rule families and synthesize their evidence yourself. Do not assume delegation exists.

## Your task
Investigate, weigh the signals across rules (independent families agreeing is far stronger than one family firing repeatedly), then reply with ONLY a JSON object (no markdown fence, no prose before or after) of exactly this shape:
{
  "aiLikelihood": <integer 0-100: probability this PR is low-oversight machine output>,
  "confidence": "low" | "medium" | "high",
  "summary": "<2-3 sentence assessment>",
  "signals": [
    { "ruleId": "<id of the rule that fired>", "observation": "<concrete evidence: quote, file reference, or metadata>", "strength": "weak" | "moderate" | "strong" }
  ],
  "recommendedAction": "none" | "label" | "comment" | "request_changes" | "close",
  "reviewerHints": ["<concrete ask the maintainer can relay to the author>", ...],
  "draftComment": "<markdown comment to post if the action needs one; empty string otherwise>"
}
Action guidance: "none" for clean PRs; "label" when likely AI-assisted but of acceptable quality; "comment" when the author should confirm or clean up; "request_changes" for substantial slop worth salvaging; "close" ONLY for unmistakable throwaway slop (hallucinated APIs, meaningless diff, description unrelated to code). Being AI-assisted is not itself a fault — judge oversight and quality, not tool use.
reviewerHints (0-10 items): concrete, actionable asks the maintainer can pass to the author to fix what the signals found — e.g. "reconcile the test counts between the description and the diff", "remove the generated bindings-status doc or regenerate it from the real output", "replace the useId reference with an export that actually exists". Each hint must map to observed evidence; no generic advice. Empty array when the PR needs nothing.
The draftComment must be specific and respectful: cite the evidence, weave in the reviewer hints as requests, never insult the author.`;
}

function generateRulePrompt(request: string): string {
  const example = BUILTIN_RULES[0]!;
  return `You are an expert on the fingerprints of low-oversight AI-generated code, writing a reusable detection rule for an AI-slop review tool.

A detection rule tells a review agent what evidence to hunt for in a pull request (description, diff, metadata, and the checked-out codebase). Its instructions are injected verbatim into that agent's prompt; the agent then reports concrete signals (observation + weak/moderate/strong strength) citing the rule.

## The user's request

${request}

## How to write it

- Turn the request into one focused signal family: what to inspect, what concrete evidence counts, and how strongly to weigh it (including when to weigh it weakly — honest disclosure or coincidence).
- Be prescriptive and self-contained: the review agent knows nothing about the tell beyond your instructions.
- Match the register of this example rule ("${example.name}"): ${example.instructions}
- Do NOT restate the tool mechanics (JSON verdict, scoring, action recommendation) — the agent's prompt already carries those; write only the rule itself.

Reply with ONLY a JSON object (no fence, no prose) of exactly this shape:
{
  "name": "<rule name, ≤ 60 chars>",
  "description": "<one line for the rules list, ≤ 200 chars>",
  "instructions": "<the rule, one dense paragraph or a few, ≤ 6000 chars>"
}`;
}

/**
 * Tolerant extraction, strict validation — a miss is failure, never a guess.
 * Signal rule ids resolve to names from the rule set the run used; an id the
 * model invented survives verbatim as its own name rather than being dropped.
 */
export function parseSlopVerdict(text: string, rules: readonly SlopRuleRecord[]): SlopVerdict {
  const parsed = verdictSchema.parse(extractModelJson(text));
  const names = new Map(rules.map((rule) => [rule.id, rule.name]));
  return {
    ...parsed,
    signals: parsed.signals.map((signal) => ({
      ...signal,
      ruleName: names.get(signal.ruleId) ?? signal.ruleId,
    })),
  };
}

function signalsMarkdown(signals: ReadonlyArray<SlopSignal>): string {
  return signals.map((s) => `- **${s.ruleName}** (${s.strength}): ${s.observation}`).join('\n');
}
