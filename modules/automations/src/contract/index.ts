// Brings core's + workspace's + operate's + code's + plan's augmentations
// (automations dependsOn all five — it sits at the top of the module graph).
import '@companion/module-core/contract';
import '@companion/module-workspace/contract';
import '@companion/module-operate/contract';
import '@companion/module-code/contract';
import '@companion/module-plan/contract';
// Soft runtime dependency: contributor flows use the board when it is enabled,
// while digests/webhooks keep working on installations that omit it.
import '@companion/module-board/contract';
import type { BriefingCadence } from '@companion/module-code/contract';
import type { AutomationsService } from '../api/automations-service.js';

/**
 * module-automations contract slice — the reactor module: the GitHub webhook
 * receiver, the slow schedule ticker (digests, stale sweeps, briefings,
 * auto-merge) and AI Help (the platform-operating assistant).
 *
 * Repository contributor-flow policy and the payload-free delivery queue view
 * live here because this module owns both lifecycles.
 */

declare module '@moxxy/companion-contracts' {
  interface PermissionRegistry {
    'automations:manage': true;
  }
  interface ServerMessageRegistry {
    /** Durable webhook queue or contributor-flow state changed. */
    'automations.changed': { readonly area: 'briefing' | 'controls' | 'deliveries' | 'flows' };
  }
  interface ServiceMap {
    /** The reactor bundle: webhook receiver + schedule ticker (`automations`) and AI Help (`assistant`). */
    automations: AutomationsService;
  }
}

/** A durable workspace report schedule and the profile whose authority it uses. */
export interface WorkspaceBriefingSchedule {
  readonly cadence: BriefingCadence;
  readonly ownerId: string | null;
}

/** A repository's end-to-end operating posture. */
export type ContributorFlowMode = 'off' | 'governed' | 'autonomous';

/** Issue kinds that may become implementation work without another prompt. */
export type ActionableIssueKind = 'bug' | 'feature' | 'docs' | 'chore';

/**
 * One owner-approved repository lifecycle. The row is scoped to a workspace so
 * the resulting task has an unambiguous board, even when a repository appears
 * in several workspaces.
 */
export interface ContributorFlowPolicy {
  readonly workspaceId: string;
  readonly repo: string;
  readonly mode: ContributorFlowMode;
  readonly actionableIssueKinds: ReadonlyArray<ActionableIssueKind>;
  /** true queues work immediately; false admits it to the board backlog. */
  readonly queueIssues: boolean;
  /** Apply labels from a successful triage verdict; never posts prose. */
  readonly autoApplyTriage: boolean;
  readonly mergeMethod: 'merge' | 'squash' | 'rebase';
  readonly maxAttempts: number;
  readonly ownerId: string;
  readonly updatedAt: number;
}

export type AutomationDeliveryStatus = 'queued' | 'processing' | 'retrying' | 'completed' | 'failed';

/** Public, payload-free projection of one GitHub delivery job. */
export interface AutomationDeliveryRecord {
  readonly id: string;
  readonly repo: string;
  readonly event: string;
  readonly action: string;
  readonly status: AutomationDeliveryStatus;
  readonly stage: string;
  readonly attempts: number;
  readonly nextAttemptAt: number | null;
  readonly lastError: string | null;
  readonly receivedAt: number;
  readonly completedAt: number | null;
}

export interface AutomationDeliveryHealth {
  readonly queued: number;
  readonly processing: number;
  readonly retrying: number;
  readonly failed: number;
  readonly recent: ReadonlyArray<AutomationDeliveryRecord>;
}

/**
 * Repository-scoped admission gate. Pausing refuses NEW signed webhook work
 * and automatic schedule starts while already-durable work drains normally.
 * This is deliberately separate from disabling a flow: incident response must
 * not destroy the policy an operator intends to resume.
 */
export interface AutomationAdmissionControl {
  readonly repo: string;
  readonly paused: boolean;
  readonly reason: string | null;
  readonly pausedBy: string | null;
  readonly pausedAt: number | null;
}

export type AutonomyReadinessStatus = 'ready' | 'attention' | 'blocked';
export type AutonomyReadinessCheckStatus = 'pass' | 'warning' | 'blocked';

/** One deterministic fact used to explain whether unattended work is safe. */
export interface AutonomyReadinessCheck {
  readonly id: string;
  readonly label: string;
  readonly status: AutonomyReadinessCheckStatus;
  readonly detail: string;
}

/**
 * The operational lane a PR would enter. This is not a quality verdict: in
 * particular, contributor/agent provenance never selects a lane by itself.
 */
export type ContributorPullLane =
  | 'wait-for-author'
  | 'repair-first'
  | 'map-and-split'
  | 'bounded-review'
  | 'standard-review'
  | 'evidence-gate';

/** Bounded, body-free projection returned by a repository autonomy dry run. */
export interface ContributorPullDryRun {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: string;
  readonly draft: boolean;
  /** Provenance only; never a quality or trust verdict. */
  readonly agentAuthored: boolean;
  readonly changedLines: number | null;
  readonly changedFiles: number | null;
  readonly mergeability: 'mergeable' | 'conflicting' | 'unknown';
  readonly ci: 'passing' | 'failing' | 'pending' | 'none' | 'unknown';
  readonly lane: ContributorPullLane;
  readonly reasons: ReadonlyArray<string>;
}

export interface ContributorDryRunWorkload {
  readonly openIssues: number;
  readonly unlabelledIssues: number;
  readonly unassignedIssues: number;
  readonly openPulls: number;
  readonly measuredPulls: number;
  readonly drafts: number;
  readonly agentAuthored: number;
  readonly conflicting: number;
  readonly knownChangedLines: number;
  readonly medianChangedLines: number | null;
  readonly atLeastOneThousandLines: number;
  readonly atLeastTenThousandLines: number;
  readonly atLeastFiftyFiles: number;
  readonly ciPassing: number;
  readonly ciFailing: number;
  readonly ciPending: number;
  readonly ciUnknown: number;
  readonly lanes: {
    readonly waitForAuthor: number;
    readonly repairFirst: number;
    readonly mapAndSplit: number;
    readonly boundedReview: number;
    readonly standardReview: number;
    readonly evidenceGate: number;
  };
}

export interface GitHubRateLimitReadiness {
  readonly limit: number | null;
  readonly remaining: number | null;
  readonly resetAt: number | null;
  readonly resource: string | null;
  readonly observedAt: number;
}

/**
 * A read-only simulation over the forge's current open queue. It never starts
 * an agent/pipeline and never mutates GitHub; incompleteness is explicit so a
 * large repository cannot look safe merely because the measurement was cut.
 */
export interface ContributorFlowDryRun {
  readonly repo: string;
  readonly workspaceId: string;
  readonly mode: Exclude<ContributorFlowMode, 'off'>;
  readonly observedAt: number;
  readonly status: AutonomyReadinessStatus;
  readonly dryRun: true;
  readonly githubMutations: 0;
  readonly agentRuns: 0;
  readonly source: {
    readonly state: 'live' | 'unavailable';
    readonly pullListComplete: boolean;
    readonly issueListComplete: boolean;
    readonly pullDetailsComplete: boolean;
    readonly detailLimit: number;
    readonly error: string | null;
  };
  readonly rateLimit: GitHubRateLimitReadiness | null;
  readonly checks: ReadonlyArray<AutonomyReadinessCheck>;
  readonly workload: ContributorDryRunWorkload;
  readonly pulls: ReadonlyArray<ContributorPullDryRun>;
}
