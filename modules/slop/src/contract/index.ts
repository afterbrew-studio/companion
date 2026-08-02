// Import the contract of every module we depend on so their augmentations
// (permissions, services, messages) are visible in this compilation.
import '@companion/module-core/contract';
import '@companion/module-workspace/contract';
import '@companion/module-operate/contract';
import '@companion/module-code/contract';
// Soft dependency: the action is only available while refinement is enabled.
import '@companion/module-refinement/contract';
import type { SlopService } from '../api/slop-service.js';

declare module '@moxxy/companion-contracts' {
  interface PermissionRegistry {
    'slop:read': true;
    'slop:act': true;
    'slop:manage': true;
  }
  interface ServerMessageRegistry {
    'slop.changed': Record<never, never>;
  }
  interface ServiceMap {
    slop: SlopService;
  }
  interface BusEvents {
    /**
     * A detection stored a verdict. Soft consumers (e.g. the board flagging a
     * task whose PR scored high) subscribe here — no dependsOn edge needed.
     */
    'slop.verdict': {
      readonly repo: string;
      readonly prNumber: number;
      readonly aiLikelihood: number;
      readonly recommendedAction: SlopAction;
    };
  }
}

/** What the human is advised to do about a slop verdict. */
export type SlopAction = 'none' | 'label' | 'comment' | 'request_changes' | 'close';
export type SlopAppliedAction = SlopAction | 'refinement';

export type SlopConfidence = 'low' | 'medium' | 'high';

/** Maintainer-facing quality bucket, deliberately independent of AI authorship. */
export type PrQualityClass = 'valuable' | 'promising' | 'needs_evidence' | 'low_value' | 'unsafe';
export type PrTechnicalRisk = 'low' | 'medium' | 'high' | 'critical';
export type PrTestEvidence = 'strong' | 'partial' | 'weak' | 'none' | 'unavailable';
export type PrReviewability = 'ready' | 'needs_split' | 'blocked';

/** One auditable reason a PR landed in its quality bucket. */
export interface PrDecisionFactor {
  readonly dimension: 'value' | 'correctness' | 'tests' | 'scope' | 'provenance';
  readonly effect: 'positive' | 'negative' | 'neutral';
  readonly observation: string;
}

/** One piece of evidence a detection rule produced. */
export interface SlopSignal {
  /** The rule that fired (built-in or custom id; unknown ids survive verbatim). */
  readonly ruleId: string;
  /** Resolved display name at detection time — stable even if the rule is later edited. */
  readonly ruleName: string;
  /** Concrete evidence: a quote, file reference, or metadata observation. */
  readonly observation: string;
  readonly strength: 'weak' | 'moderate' | 'strong';
}

export interface SlopVerdict {
  /** 0–100: how likely the PR was substantially machine-generated with low human oversight. */
  readonly aiLikelihood: number;
  readonly confidence: SlopConfidence;
  /** Overall usefulness/readiness. Never inferred from aiLikelihood alone. */
  readonly qualityClass: PrQualityClass;
  /** 0–100: evidenced benefit to users or maintainers relative to the churn. */
  readonly valueScore: number;
  /** 0–100: strength of tests, CI, reproduction, and description↔diff proof. */
  readonly evidenceScore: number;
  readonly technicalRisk: PrTechnicalRisk;
  readonly testEvidence: PrTestEvidence;
  /** Whether the change can be decided safely at its current size and shape. */
  readonly reviewability: PrReviewability;
  readonly decisionFactors: ReadonlyArray<PrDecisionFactor>;
  readonly summary: string;
  readonly signals: ReadonlyArray<SlopSignal>;
  readonly recommendedAction: SlopAction;
  /**
   * Concrete asks the maintainer can relay to the PR author to raise the
   * oversight bar (reconcile the description, drop generated docs, add the
   * missing tests…). Empty when the PR needs nothing.
   */
  readonly reviewerHints: ReadonlyArray<string>;
  /** Markdown body used by the comment / request-changes / close actions; may be empty. */
  readonly draftComment: string;
}

/**
 * The author's standing in the repository, straight from GitHub. 'unknown' is
 * its own state: a payload shape that omits the field must not be reported as
 * NONE, which would read as "outsider" and skew every provenance judgement.
 */
export type SlopAuthorStanding =
  | 'owner'
  | 'member'
  | 'collaborator'
  | 'contributor'
  | 'first_time_contributor'
  | 'bot'
  | 'none'
  | 'unknown';

/** One commit on the pull request, reduced to what a provenance judgement needs. */
export interface SlopCommitFact {
  /** Short sha, enough to cite in an observation. */
  readonly sha: string;
  /** First line of the message. */
  readonly subject: string;
  /** Linked GitHub login, or null when the commit email matches no account. */
  readonly authorLogin: string | null;
  readonly authoredAt: number;
  /** Trailer keys found in the message's trailer block, lowercased. */
  readonly trailers: ReadonlyArray<string>;
}

/**
 * Facts about where a pull request came from, fetched from GitHub at detection
 * time. Every field is evidence the agent may cite; nothing here is a verdict.
 * The whole record is null when GitHub could not be reached, which the prompt
 * states explicitly so the agent withholds provenance claims instead of
 * inventing them.
 */
export interface SlopProvenance {
  readonly authorLogin: string;
  readonly standing: SlopAuthorStanding;
  /** Days since the account was created; null when the profile was unreadable. */
  readonly accountAgeDays: number | null;
  readonly publicRepos: number | null;
  readonly followers: number | null;
  readonly commits: ReadonlyArray<SlopCommitFact>;
  /** True when the commit list hit the page cap, so counts are a lower bound. */
  readonly commitsTruncated: boolean;
  /** Distinct AI attribution trailers seen (e.g. 'co-authored-by: claude'). */
  readonly aiTrailers: ReadonlyArray<string>;
  /** Every commit carries a Signed-off-by line (DCO satisfied). */
  readonly signedOff: boolean;
  /** Distinct commit author identities across the PR. */
  readonly distinctAuthors: number;
  /** Minutes between the first and last commit; null for a single commit. */
  readonly spanMinutes: number | null;
  /** Agent-tool prefix on the head branch (codex/, cursor/, devin/…), if any. */
  readonly branchAgentPrefix: string | null;
}

export interface SlopDetectionResult {
  readonly id: string; // `slop-<uuid12>`
  readonly repo: string; // owner/name
  readonly prNumber: number;
  /** Denormalized so history survives cache churn and PR deletion. */
  readonly prTitle: string;
  /** Empty while the detection is still 'running' (the run hasn't been assigned yet). */
  readonly runId: string;
  /** 'running' = the agent phase is in flight; the row exists so the UI shows progress immediately. */
  readonly status: 'running' | 'pending' | 'applied' | 'dismissed' | 'failed';
  readonly verdict: SlopVerdict | null;
  readonly error: string | null;
  /** What the human actually applied (may differ from the recommendation). */
  readonly appliedAction: SlopAppliedAction | null;
  /** Snapshot of the rule set the detection ran with. */
  readonly ruleIds: ReadonlyArray<string>;
  /**
   * Contributor facts the detection ran with, snapshotted so the evidence stays
   * legible after the PR is force-pushed or the author's profile changes. null
   * when GitHub was unreachable, and on rows written before this existed.
   */
  readonly provenance: SlopProvenance | null;
  readonly createdAt: number;
}

export interface SlopMoveToRefinementResult {
  readonly refinementId: string;
}

/** An AI-drafted rule: prefills the editor for review — nothing stored until the user saves. */
export interface SlopRuleDraft {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
}

/** A detection rule — built-in or user-defined per workspace. */
export interface SlopRuleRecord {
  readonly id: string; // 'builtin-…' or `sr-<uuid12>`
  /** null = built-in. */
  readonly workspaceId: string | null;
  readonly name: string;
  readonly description: string;
  /** Heuristics fed verbatim to the detection agent. */
  readonly instructions: string;
  readonly builtin: boolean;
  /** Effective for the listing workspace (built-ins can be toggled per workspace). */
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}
