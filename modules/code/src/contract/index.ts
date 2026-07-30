// Brings core's + workspace's + operate's augmentations (code dependsOn all three).
import '@companion/module-core/contract';
import '@companion/module-workspace/contract';
import '@companion/module-operate/contract';
import type { ChecksSnapshot } from './checks.js';
import type { CodeService } from '../api/code-service.js';

export * from './checks.js';
export * from './pipelines.js';

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
  }
  interface ServerMessageRegistry {
    'repos.changed': Record<never, never>;
    'issues.changed': { readonly repo: string };
    'triage.changed': { readonly repo: string };
    'prs.changed': { readonly repo: string };
    'pipelines.changed': Record<never, never>;
    'pipelineRuns.changed': { readonly repo: string };
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
  /** Set once a webhook secret was generated (receiver active). */
  readonly webhookConfigured: boolean;
  /** Profile responsible for unattended repo automation; null means paused/unclaimed. */
  readonly automationOwnerId: string | null;
  /** @deprecated Always null; account resolution is personal per profile. */
  readonly githubAccountId: string | null;
  /** Preferred runner for this repo's agent work; null = auto-place among eligible. */
  readonly runnerId: string | null;
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
  };
  /** null for a preset that turns everything off and creates nothing. */
  readonly pipeline: {
    readonly name: string;
    readonly description: string;
    readonly autoRunOnPrOpen: boolean;
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
  readonly pipelineSkipped: 'not-permitted' | 'no-steps-left' | null;
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
  readonly triage: 'pending' | 'applied' | 'dismissed' | null;
}

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
  readonly review: 'pending' | 'applied' | 'dismissed' | null;
  /** Risk from the latest AI review verdict — the auto-merge/priority signal. */
  readonly reviewRisk: 'low' | 'medium' | 'high' | null;
  /** Human review decision on GitHub (folded per reviewer, latest wins). */
  readonly reviewDecision: 'approved' | 'changes_requested' | null;
  /** Whether GitHub can merge cleanly; null = unknown (still computing / not fetched). */
  readonly mergeable: boolean | null;
  /** Latest CI pipeline snapshot (null until first fetch). */
  readonly checks: ChecksSnapshot | null;
}

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

// ---------- PR reviews -----------------------------------------------------------

export interface PrReviewVerdict {
  readonly summary: string;
  readonly risk: 'low' | 'medium' | 'high';
  readonly recommendation: 'approve' | 'request_changes' | 'comment';
  readonly findings: ReadonlyArray<string>;
  readonly reviewBody: string;
}

export interface PrReviewResult {
  readonly id: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly runId: string;
  readonly status: 'pending' | 'applied' | 'dismissed' | 'failed';
  readonly verdict: PrReviewVerdict | null;
  readonly error: string | null;
  readonly createdAt: number;
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
  readonly status: 'pending' | 'applied' | 'dismissed' | 'failed';
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
  /** Deliveries POST here (behind the public tunnel / the user's port-forward). */
  readonly path: string;
  /** Only returned to the profile that owns the registration. */
  readonly secret: string | null;
  /** Absolute delivery URL when the moxxy-proxy tunnel is up; null otherwise. */
  readonly url: string | null;
  readonly ownerId: string | null;
  readonly accountId: string | null;
  readonly accountLogin: string | null;
  readonly managedByYou: boolean;
}

/** How often a workspace's briefing report is generated. */
export type BriefingCadence = 'off' | 'daily' | 'weekly';
