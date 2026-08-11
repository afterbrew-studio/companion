// Brings core's + workspace's + operate's augmentations (code dependsOn all three).
import '@companion/module-core/contract';
import '@companion/module-workspace/contract';
import '@companion/module-operate/contract';
import '@companion/module-integrations/contract';
import type { IntegrationTargetRef } from '@companion/module-integrations/contract';
import type { ChecksSnapshot } from './checks.js';
import type { DiffSide } from './diff-anchors.js';
import type { CodeService } from '../api/code-service.js';

export * from './checks.js';
export * from './pipelines.js';
export * from './diff-anchors.js';
export * from './review-chunks.js';

/**
 * module-code contract slice — the GitHub-facing domain: repositories + the
 * multi-account registry, the issues/PRs sync cache (GitHub stays
 * authoritative), triage, AI reviews + CI checks, and pipelines.
 */

declare module '@moxxy/companion-contracts' {
  interface PermissionRegistry {
    'repos:read': true;
    'repos:manage': true;
    'issues:read': true;
    'issues:act': true;
    'prs:read': true;
    'prs:act': true;
    'pipelines:read': true;
    'pipelines:manage': true;
    'pipelines:run': true;
    'github:connect': true;
    'pipelines:execute': true;
    'pipelines:author-execute': true;
  }
  interface ServerMessageRegistry {
    'repos.changed': Record<never, never>;
    'issues.changed': { readonly repo: string };
    'triage.changed': { readonly repo: string };
    'prs.changed': { readonly repo: string };
    /** One PR's frequently refreshed CI/review state; list views patch it in place. */
    'prStatus.changed': {
      readonly repo: string;
      readonly number: number;
      readonly status: PrStatusSnapshot;
    };
    'pipelines.changed': Record<never, never>;
    'pipelineRuns.changed': { readonly repo: string };
    /** A chunk of a command's bounded, persisted, secret-scrubbed output. */
    'pipelineStep.output': {
      readonly repo: string;
      readonly runId: string;
      /** Raw live output is owner-only; other maintainers replay it through authenticated REST. */
      readonly ownerId: string;
      readonly stepIndex: number;
      readonly sequence: number;
      readonly chunk: string;
    };
  }
  interface ServiceMap {
    /** The GitHub/code domain: repos + accounts + sync cache + triage/reviews/checks/fixes/pipelines. */
    code: CodeService;
  }
}

// ---------- GitHub domain -----------------------------------------------------

export interface RepoRecord {
  /** `owner/name` — the primary key everywhere. */
  readonly fullName: string;
  readonly owner: string;
  readonly name: string;
  /** Workspace context this record was listed for. A repo may belong to several workspaces. */
  readonly workspaceId: string;
  readonly defaultBranch: string;
  readonly private: boolean;
  readonly cloneReady: boolean;
  readonly lastSyncAt: number | null;
  readonly openIssues: number;
  /** Proven against one of the current profile's own accounts for this response. */
  readonly githubAccessible: boolean;
  /**
   * The BEST permission the current profile's own accounts hold here, proven
   * for this response; null when the repo is invisible to all of them. Actions
   * gate on this so a user is never offered work their credentials can't land
   * (writing needs 'push' or better; webhooks need 'admin').
   */
  readonly githubPermission: RepoPermission | null;
  /**
   * Command run in an agent's worktree before a human is asked to review its
   * diff, e.g. `pnpm -s typecheck`. null means nothing is checked, which is
   * reported as "not verified" rather than as a pass.
   */
  readonly verifyCommand: string | null;
  /** Automation switches. */
  readonly autoTriage: boolean;
  readonly digestEnabled: boolean;
  readonly staleSweepEnabled: boolean;
  /** Auto-analyze newly opened PRs (webhook) and post the review when confident. */
  readonly prGateEnabled: boolean;
  /** Auto-merge open PRs that are green + human-approved + AI-reviewed low risk. */
  readonly autoMergeEnabled: boolean;
  /**
   * Answer in thread when a PR author replies to one of the agent's inline
   * review comments. The only switch here that makes an agent speak publicly on
   * someone else's pull request, so it is off until a maintainer turns it on.
   */
  readonly reviewRepliesEnabled: boolean;
  /** Set once a webhook secret was generated (receiver active). */
  readonly webhookConfigured: boolean;
  /** Profile responsible for unattended repo automation; null means paused/unclaimed. */
  readonly automationOwnerId: string | null;
  /** Preferred runner for this repo's agent work; null = auto-place among eligible. */
  readonly runnerId: string | null;
}

/** A trusted, bounded repository file that can shape an agent run. */
export interface RepoAgentContextFile {
  readonly path: string;
  readonly kind: 'instructions' | 'skill' | 'pull-request-template';
  /** Frontmatter name for a skill, otherwise a human-readable filename. */
  readonly name: string;
  /** Frontmatter description when the repository supplied one. */
  readonly description: string | null;
  /** Plain UTF-8 text from the scanned base branch, never from a PR head. */
  readonly content: string;
  readonly size: number;
  /** True when the file was too large to include in full. */
  readonly truncated: boolean;
  /** The one template Companion will merge into a newly opened PR. */
  readonly primary: boolean;
}

/** Repository conventions Companion can enforce without executing repo code. */
export interface RepoAgentContextPolicies {
  /** Companion's platform default: commits and PR copy receive no AI credit trailer. */
  readonly noAiAttribution: true;
  /** A trusted rule explicitly asks for newly created pull requests to be drafts. */
  readonly pullRequestDraft: boolean;
  /** The trusted rules describe Conventional Commit-style PR titles. */
  readonly conventionalPrTitle: boolean;
  /** The selected PR template explicitly asks whether an agent produced the diff. */
  readonly agentProvenance: boolean;
  /** Branch prefixes shown in trusted examples such as `fix/<short-topic>`. */
  readonly branchPrefixes: readonly string[];
}

/**
 * What Companion discovered on the repository's trusted base branch. The SPA
 * and fix runs share this bounded representation and scanner, rather than
 * maintaining separate UI and execution interpretations.
 */
export interface RepoAgentContext {
  readonly repo: string;
  readonly ref: string;
  readonly scannedAt: number;
  readonly files: readonly RepoAgentContextFile[];
  /** The Git tree or configured resource ceilings omitted additional content. */
  readonly truncated: boolean;
  readonly policies: RepoAgentContextPolicies;
}

// ---------- agent quality ----------

/**
 * How one kind of agent verdict is faring with the humans reviewing it.
 *
 * Derived from the outcome columns that already exist (`pending` / `applied` /
 * `dismissed` / `failed`) rather than from a new recording path. That is the
 * whole design: a second write would eventually disagree with the rows it was
 * meant to describe, and there is nothing to disagree with when the number IS
 * the rows.
 */
export interface AgentQualityStat {
  /** Which agent surface: 'triage', 'ai-review', 'slop'. Free-form so a module can add its own. */
  readonly surface: string;
  readonly label: string;
  /** Verdicts a human has accepted (applied to GitHub). */
  readonly accepted: number;
  /** Verdicts a human rejected outright. The false-positive signal. */
  readonly rejected: number;
  /** Still awaiting a decision, so excluded from the rate rather than counted as either. */
  readonly pending: number;
  /**
   * Runs that produced no verdict at all. A reliability number, not a quality
   * one, and kept separate for exactly that reason.
   */
  readonly failed: number;
  /** Runs a maintainer deliberately stopped; neither pending nor a reliability failure. */
  readonly cancelled?: number;
  /** accepted / (accepted + rejected); null until a human has decided anything. */
  readonly acceptanceRate: number | null;
  /**
   * Decided verdicts where the human applied something other than what was
   * recommended. Neither acceptance nor rejection: the finding was right and the
   * proposed response was too strong or too weak. null where a surface has no
   * recommendation to override.
   */
  readonly overridden: number | null;
}

/** The quality payload for one workspace over a window. */
export interface AgentQuality {
  /** Start of the window, ms since epoch. */
  readonly since: number;
  readonly surfaces: readonly AgentQualityStat[];
}

// ---------- repository presets ----------

export { REPO_PRESETS, findPreset, resolveSteps } from './presets.js';

export type RepoPresetId = 'oss' | 'internal' | 'watch';

/**
 * A starting configuration for a newly connected repository: the automation
 * switches plus, optionally, one pipeline to create. Everything a preset writes
 * stays editable afterwards; it is a shortcut, never a mode.
 */
export interface RepoPreset {
  readonly id: RepoPresetId;
  readonly label: string;
  readonly description: string;
  readonly automation: {
    readonly autoTriage: boolean;
    readonly digest: boolean;
    readonly staleSweep: boolean;
    readonly prGate: boolean;
    readonly autoMerge: boolean;
    readonly reviewReplies: boolean;
  };
  /** null for a preset that turns everything off and creates nothing. */
  readonly pipeline: {
    readonly name: string;
    readonly description: string;
    readonly autoRunOnPrOpen: boolean;
    readonly autoRunOnPrUpdate: boolean;
    readonly steps: ReadonlyArray<PresetStepShorthand>;
  } | null;
}

/** How a preset names its steps. Expanded to full step specs on apply. */
export type PresetStepShorthand =
  | { readonly kind: 'slop-check'; readonly threshold: number }
  | { readonly kind: 'ai-review'; readonly post: boolean; readonly failOn: 'request_changes' | 'high_risk' | 'never' }
  | { readonly kind: 'checks-gate'; readonly allowPending: boolean };

/** What applying a preset actually did, so the UI can report it rather than imply it. */
export interface RepoPresetResult {
  readonly preset: RepoPresetId;
  /** Id of the pipeline created, or null when the preset creates none. */
  readonly pipelineId: string | null;
  /**
   * Step kinds left out because the module that owns them is not enabled here.
   * Reported rather than dropped quietly: a slop screen that is not running is
   * exactly the thing someone would otherwise assume was.
   */
  readonly skippedSteps: readonly string[];
  /**
   * Why the preset's pipeline was not created, when it defines one. null means
   * it was created (or the preset defines none).
   */
  readonly pipelineSkipped: 'not-permitted' | 'account-unavailable' | 'no-steps-left' | null;
}

/** A repository a reachable GitHub account can see — the add-repo picker feed. */
export interface RepoCandidate {
  readonly fullName: string;
  readonly private: boolean;
  readonly description: string | null;
  readonly pushedAt: number | null;
  /** Login of the account that sees it (highest-precedence when several do). */
  readonly accountLogin: string;
}

/** One existing remote branch offered by branch-selection controls. */
export interface RepoBranchRecord {
  readonly name: string;
  readonly protected: boolean;
}

/** A repository whose refresh failed for a reason other than access. */
export interface RepoSyncFailure {
  readonly repo: string;
  /** One line: GitHub's own message, or the local failure. */
  readonly reason: string;
}

/** Result of refreshing every repository in one workspace for the current user. */
export interface WorkspaceSyncResult {
  /** Repositories no connected GitHub account may read; their cached rows stay hidden. */
  readonly unavailableRepos: readonly string[];
  /** Repositories the refresh could not reach; the last synced rows stay visible. */
  readonly failedRepos: readonly RepoSyncFailure[];
}

export interface IssueRecord {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: 'open' | 'closed';
  readonly labels: ReadonlyArray<string>;
  readonly author: string;
  readonly assignees: ReadonlyArray<string>;
  readonly comments: number;
  readonly url: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly closedAt: number | null;
  /** Latest triage result status for this issue, if any. */
  readonly triage: 'running' | 'pending' | 'applied' | 'dismissed' | null;
}

/** Lightweight maintainer-queue row; the full body is fetched on detail open. */
export type IssueListRecord = Omit<IssueRecord, 'body'>;

/**
 * GitHub's merge-state vocabulary (REST `mergeable_state`, GraphQL
 * `mergeStateStatus`). `behind` only blocks when the base requires up-to-date
 * branches, which is why a gate has to read branch protection rather than treat
 * every non-clean value the same.
 */
export type MergeStateStatus =
  | 'clean'
  | 'dirty'
  | 'blocked'
  | 'behind'
  | 'unstable'
  | 'draft'
  | 'has_hooks'
  | 'unknown';

export interface PrRecord {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: 'open' | 'closed' | 'merged';
  readonly headRef: string;
  readonly headSha: string | null;
  readonly baseRef: string;
  readonly draft: boolean;
  readonly author: string;
  readonly labels: ReadonlyArray<string>;
  readonly assignees: ReadonlyArray<string>;
  /** Conversation comment count (harvested from the issues feed; 0 until synced). */
  readonly comments: number;
  readonly url: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** When the PR was closed or merged. */
  readonly closedAt: number | null;
  /** Latest AI review status for this PR, if any. */
  readonly review: 'running' | 'pending' | 'applied' | 'dismissed' | null;
  /** Risk from the latest AI review verdict — the auto-merge/priority signal. */
  readonly reviewRisk: 'low' | 'medium' | 'high' | null;
  /** Human review decision on GitHub (folded per reviewer, latest wins). */
  readonly reviewDecision: 'approved' | 'changes_requested' | null;
  /** Whether GitHub can merge cleanly; null = unknown (still computing / not fetched). */
  readonly mergeable: boolean | null;
  /**
   * Why it cannot merge, when it cannot. `mergeable: false` alone conflates
   * conflicts (fix the branch), a missing required check (wait or investigate),
   * and being behind a strict base (update the branch), which need different
   * responses. null = not fetched yet.
   */
  readonly mergeStateStatus: MergeStateStatus | null;
  /** Latest CI pipeline snapshot (null until first fetch). */
  readonly checks: ChecksSnapshot | null;
}

/** Lightweight maintainer-queue row; the full body is fetched on detail open. */
export type PrListRecord = Omit<PrRecord, 'body'>;

/** Fields refreshed together by the checks warm-up without changing list order. */
export type PrStatusSnapshot = Pick<
  PrRecord,
  'checks' | 'reviewDecision' | 'mergeable' | 'mergeStateStatus'
>;

/**
 * One changed file in a PR, from GitHub's paginated files API — which, unlike
 * the single `.diff` payload, never 406s on large pull requests. `patch` is the
 * unified hunk body; GitHub omits it for binary files and very large diffs.
 */
export interface PrFileChange {
  readonly filename: string;
  readonly previousFilename: string | null;
  readonly status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  readonly additions: number;
  readonly deletions: number;
  readonly patch: string | null;
}

/**
 * One server-bounded window of a PR's files for the interactive diff browser.
 * `hasNextPage` is explicit so an incomplete window can never look like the
 * complete pull request. Aggregate AI review coverage is tracked separately.
 */
export interface PrFileChangesPage {
  readonly files: ReadonlyArray<PrFileChange>;
  readonly page: number;
  readonly pageSize: number;
  readonly hasNextPage: boolean;
}

// ---------- PR reviews -----------------------------------------------------------

export interface PrReviewVerdict {
  readonly summary: string;
  readonly risk: 'low' | 'medium' | 'high';
  readonly recommendation: 'approve' | 'request_changes' | 'comment';
  /**
   * Finding TITLES only, and a denormalized view at that: the findings
   * themselves live in their own table, addressed as `PrReviewResult.findings`.
   * Kept written so consumers predating anchored findings (the board's review
   * card) keep rendering; new code must read the structured findings instead.
   */
  readonly findings: ReadonlyArray<string>;
  readonly reviewBody: string;
}

/** Which part of a potentially multi-run review is currently executing. */
export type PrReviewPhase = 'queued' | 'planning' | 'reviewing' | 'verifying' | 'summarizing' | 'complete';

/**
 * Default aggregate token ceiling for one PR review, across chunks,
 * adversarial verifiers and the final summary. Provider usage is folded while
 * children run. A review can still overshoot by responses already in flight
 * when telemetry reaches the ceiling; those children are stopped immediately
 * and no new turn is admitted.
 */
export const DEFAULT_MAX_PR_REVIEW_TOKENS = 2_000_000;

/**
 * Durable progress for the aggregate review, not for one underlying agent run.
 * A large PR can create many runs; this is the stable thing the maintainer
 * follows across navigation, reconnects, and daemon restarts.
 */
export interface PrReviewProgress {
  readonly phase: PrReviewPhase;
  readonly completed: number;
  readonly total: number;
  readonly message: string;
  readonly updatedAt: number;
  /** Aggregate limits shared by chunks, verifiers, and the final summary. */
  readonly budget?: PrReviewBudgetProgress;
}

/** Durable, user-visible guardrails for one aggregate review operation. */
export interface PrReviewBudgetProgress {
  /** Child turns claimed so far; monotonic even when a queued turn is cancelled. */
  readonly modelCalls: number;
  readonly maxModelCalls: number;
  readonly startedAt: number;
  readonly deadlineAt: number;
  /**
   * Added after aggregate reviews shipped, so it is optional for old persisted
   * rows. Every newly-started review carries it from its first progress event.
   */
  readonly tokenUsage?: PrReviewTokenBudgetProgress;
}

/** Reported usage and estimated spend for every child in one review. */
export interface PrReviewTokenBudgetProgress {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly maxTokens: number;
  /** Children observed with usable token telemetry, including active runs. */
  readonly reportedRuns: number;
  /** Children that ran without usable telemetry; any such child stops review. */
  readonly missingRuns: number;
  /** Sum of list-price estimates for priced children only. */
  readonly estimatedCostUsd: number;
  /** True when missing telemetry or an unpriced model makes cost a lower bound. */
  readonly costPartial: boolean;
}

/** How much of the requested review was actually read successfully. */
export interface PrReviewCoverage {
  readonly state: 'complete' | 'partial' | 'unavailable';
  readonly reviewedGroups: number;
  readonly totalGroups: number;
  readonly reviewedFiles: number;
  readonly totalFiles: number;
  /** Bounded, human-readable groups that could not be reviewed. */
  readonly unread: ReadonlyArray<string>;
}

/** A terminal review that read anything has partial evidence, never unavailable evidence. */
export function terminalReviewCoverage(coverage: PrReviewCoverage): PrReviewCoverage {
  return coverage.state === 'unavailable' && (coverage.reviewedGroups > 0 || coverage.reviewedFiles > 0)
    ? { ...coverage, state: 'partial' }
    : coverage;
}

/** How hard the review agent looks; also decides whether findings are anchored. */
export type ReviewDepth = 'high-level' | 'in-depth';

/**
 * How much noise a review is allowed to surface. Applied as a severity floor
 * when findings are stored — deliberately NOT enforced by prompt wording alone,
 * which a model routes around by relabelling a nit as a blocker to smuggle it
 * past the instruction. Everything is kept; the floor only decides what starts
 * selected, so the reviewer can reveal the rest without a second run.
 */
export type ReviewStrictness = 'blockers-only' | 'balanced' | 'pedantic';

export type FindingSeverity = 'blocker' | 'major' | 'minor' | 'nit';

/** Where a finding stands on its way to becoming a GitHub review comment. */
export type FindingState = 'proposed' | 'included' | 'rejected' | 'posted';

export type FindingVerification = 'unverified' | 'confirmed' | 'refuted';

/** A finding's position in the diff; null on a finding that has none. */
export interface DiffAnchorRef {
  readonly file: string;
  readonly side: DiffSide;
  readonly line: number;
  /** Start of a multi-line range; null anchors a single line. */
  readonly startLine: number | null;
}

/**
 * One reviewable point, which becomes at most one GitHub review comment.
 *
 * Knows nothing about pull requests: `reviewId` is its only parent, so the same
 * row shape serves a review of a local branch diff when that lands.
 */
export interface ReviewFinding {
  readonly id: string;
  readonly reviewId: string;
  /** Which reviewer produced it. `native` is the built-in agent. */
  readonly source: string;
  readonly anchor: DiffAnchorRef | null;
  readonly severity: FindingSeverity;
  readonly title: string;
  readonly reason: string;
  readonly impact: string;
  readonly suggestion: string;
  /** Literal replacement text for the anchored range; null when there is none. */
  readonly suggestedPatch: string | null;
  readonly confidence: number;
  readonly state: FindingState;
  readonly verification: FindingVerification;
  readonly verificationNote: string | null;
  readonly rejectionReason: string | null;
  readonly githubCommentId: number | null;
  readonly createdAt: number;
}

export interface PrReviewResult {
  readonly id: string;
  readonly repo: string;
  readonly prNumber: number;
  /**
   * The agent run behind this review, or null when a person started the draft
   * themselves to leave their own comments. Null is also what distinguishes the
   * two in the UI: a manual draft has no risk or recommendation to show.
   */
  readonly runId: string | null;
  /** Every run used by a split review, verifier, and summary, in start order. */
  readonly runIds: ReadonlyArray<string>;
  /** Explicit because a queued agent review has no run id yet. */
  readonly source: 'agent' | 'human';
  /** Stable integration protocol id, not merely the vendor brand. */
  readonly providerId: string;
  /** Managed results return to Companion; delegated results continue in the vendor. */
  readonly reviewMode: 'managed' | 'delegated';
  /** Vendor hand-off/result URL when the provider owns the remaining flow. */
  readonly externalUrl: string | null;
  /** Human-readable hand-off state returned by a delegated provider. */
  readonly externalSummary: string | null;
  readonly status: 'running' | 'pending' | 'applied' | 'dismissed' | 'failed' | 'cancelled';
  readonly verdict: PrReviewVerdict | null;
  readonly error: string | null;
  readonly progress: PrReviewProgress;
  readonly coverage: PrReviewCoverage;
  readonly createdAt: number;
  /**
   * The head commit the review was computed against. Anchors are only valid
   * against this commit, so publishing checks it against the PR's current head
   * rather than trusting that nothing was pushed meanwhile. Null on rows that
   * predate anchoring.
   */
  readonly headSha: string | null;
  readonly depth: ReviewDepth;
  readonly strictness: ReviewStrictness;
  /** Empty on list payloads; hydrated for detail views. */
  readonly findings: ReadonlyArray<ReviewFinding>;
}

/** Most severe first, so a floor is an index comparison. */
export const FINDING_SEVERITIES: readonly FindingSeverity[] = ['blocker', 'major', 'minor', 'nit'];

const STRICTNESS_FLOOR: Record<ReviewStrictness, FindingSeverity> = {
  'blockers-only': 'blocker',
  balanced: 'minor',
  pedantic: 'nit',
};

/** Whether a finding clears the strictness floor, i.e. starts out selected. */
export function meetsStrictness(severity: FindingSeverity, strictness: ReviewStrictness): boolean {
  return FINDING_SEVERITIES.indexOf(severity) <= FINDING_SEVERITIES.indexOf(STRICTNESS_FLOOR[strictness]);
}

/**
 * How much of a review is published.
 *
 * `comments` exists because the per-line remarks are often the whole value and
 * the write-up above them is noise on somebody else's pull request; `summary`
 * for the opposite case, where the prose is the point and inline comments would
 * clutter the diff.
 */
export type ReviewPostMode = 'full' | 'comments' | 'summary';

/** What a caller may choose when starting a review. */
export interface ReviewOptions {
  readonly depth?: ReviewDepth;
  readonly strictness?: ReviewStrictness;
  /** Run the adversarial second pass. Defaults to true for in-depth. */
  readonly verify?: boolean;
  readonly context?: string;
  /** Explicit provider/connection. Omitted means the repository's ordered route. */
  readonly provider?: IntegrationTargetRef;
  /** The workspace that gives this repository-scoped integration its policy. */
  readonly workspaceId?: string;
}

// ---------- Triage -------------------------------------------------------------

export interface TriageVerdict {
  readonly summary: string;
  readonly severity: 'critical' | 'high' | 'medium' | 'low' | 'trivial';
  readonly kind: 'bug' | 'feature' | 'question' | 'docs' | 'chore' | 'invalid';
  readonly labels: ReadonlyArray<string>;
  readonly duplicateOf: number | null;
  readonly needsInfo: boolean;
  readonly draftReply: string;
}

export interface TriageResult {
  readonly id: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly runId: string;
  readonly status: 'running' | 'pending' | 'applied' | 'dismissed' | 'failed';
  readonly verdict: TriageVerdict | null;
  readonly error: string | null;
  readonly createdAt: number;
}

// ---------- GitHub accounts ----------------------------------------------------

/** What an account is bound to do; one account can hold several purposes. */
export type GitHubPurpose = 'fetch' | 'runs' | 'pipelines' | 'webhooks';

export const GITHUB_PURPOSES: readonly GitHubPurpose[] = ['fetch', 'runs', 'pipelines', 'webhooks'];

/**
 * GitHub's repository permission ladder, as reported for the resolving token —
 * each level implies every level below it. Actions declare the LEAST level they
 * need ('push' to write a branch, 'admin' to register a webhook) so a lack of
 * rights is caught at resolution instead of surfacing as an opaque 403/404.
 */
export type RepoPermission = 'pull' | 'triage' | 'push' | 'maintain' | 'admin';

export const REPO_PERMISSION_RANK: Record<RepoPermission, number> = {
  pull: 1,
  triage: 2,
  push: 3,
  maintain: 4,
  admin: 5,
};

/** Plain wording for a permission level, for user-facing copy. */
export const REPO_PERMISSION_LABEL: Record<RepoPermission, string> = {
  pull: 'read-only',
  triage: 'triage',
  push: 'write',
  maintain: 'maintain',
  admin: 'admin',
};

/**
 * One of the caller's own accounts as a candidate for acting on a repo, graded
 * by what it may do there. `bound` marks the account this profile chose for the
 * repo — a preference that wins resolution while it stays eligible, never a
 * grant that could let another profile borrow the credential.
 */
export interface RepoAccountOption {
  readonly id: string;
  readonly login: string;
  readonly permission: RepoPermission | null;
  readonly bound: boolean;
}

/**
 * Which of the owner's workspaces a personal account may serve. This is a
 * routing preference within one Companion identity, never a sharing grant.
 */
export type GitHubAccountScope = 'all' | 'selected';

/**
 * How a connected account authenticates.
 *
 * `pat` is a personal access token. `app` is a GitHub App installation, which
 * exists because a PAT is not always available: an organisation on GitHub
 * Enterprise Cloud with SAML SSO must SSO-authorise each token, and one that
 * bans PATs outright cannot connect any other way.
 */
export type GitHubCredentialKind = 'pat' | 'app';

/** A connected GitHub account; credentials never leave the daemon. */
export interface GitHubAccountRecord {
  readonly id: string;
  readonly login: string;
  readonly purposes: readonly GitHubPurpose[];
  readonly scope: GitHubAccountScope;
  /** Workspaces this personal account serves when scope is `selected`. */
  readonly workspaceIds: ReadonlyArray<string>;
  /**
   * Companion profile that owns this credential. API records are always
   * personal, so this is never null at the contract boundary.
   */
  readonly ownerId: string;
  readonly createdAt: number;
  readonly kind: GitHubCredentialKind;
  /** App installations only, so the UI can name what it is showing. */
  readonly appId: string | null;
  readonly installationId: string | null;
  /** When the cached installation token dies. Null for a PAT. */
  readonly tokenExpiresAt: number | null;
  /**
   * Outcome of the last background token refresh. 'failing' means the app can no
   * longer mint a token (uninstalled on GitHub, rotated key, revoked access) and
   * this credential is living on borrowed time. Null when no refresh has ever
   * run, which is every PAT: they do not refresh on a schedule we know.
   */
  readonly tokenHealth: 'ok' | 'failing' | null;
  /** Why the last refresh failed. Never contains the credential itself. */
  readonly tokenError: string | null;
}

// ---------- comments / webhooks / briefings -------------------------------------

/** A GitHub issue/PR conversation comment (read-through, not cached). */
export interface CommentRecord {
  readonly author: string;
  readonly body: string;
  readonly createdAt: number;
}

export interface WebhookInfo {
  /** Deliveries POST here behind the configured public ingress. */
  readonly path: string;
  /** Absolute delivery URL when public ingress is available; null otherwise. */
  readonly url: string | null;
  readonly ownerId: string | null;
  readonly accountId: string | null;
  readonly accountLogin: string | null;
  readonly managedByYou: boolean;
  /** GitHub hook id when Companion installed/reconciled it automatically. */
  readonly remoteId: number | null;
  /** Last GitHub-side setup failure; never contains the HMAC secret. */
  readonly remoteError: string | null;
}

/** How often a workspace's briefing report is generated. */
export type BriefingCadence = 'off' | 'daily' | 'weekly';
