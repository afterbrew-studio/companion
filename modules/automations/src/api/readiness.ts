import type { PrRecord } from '@companion/module-code/contract';
import type {
  AutomationAdmissionControl,
  AutonomyReadinessCheck,
  ContributorDryRunWorkload,
  ContributorFlowDryRun,
  ContributorPullDryRun,
  ContributorPullLane,
} from '../contract/index.js';
import type { GhIssue, GhPull, GitHubClient } from './cross-types.js';

const LIST_PAGE_SIZE = 100;
const LIST_LIMIT = 1_000;
const LIST_PROBE_PAGES = LIST_LIMIT / LIST_PAGE_SIZE + 1;
const DETAIL_LIMIT = 100;
const DETAIL_CONCURRENCY = 6;
const CURRENT_CHECKS_MS = 10 * 60_000;
const LARGE_REVIEW_LINES = 1_000;
const LARGE_REVIEW_FILES = 50;
const OVERSIZED_REVIEW_LINES = 14_400;
const OVERSIZED_REVIEW_FILES = 500;

/** Provenance lives in the pull-request body, never as a GitHub label. */
export function agentAuthoredFromBody(body: string | null | undefined): boolean {
  if (!body) return false;
  if (/(?:^|\n)\s*-\s*\[\s*[xX]\s*\][^\n]*agent-authored/i.test(body)) return true;
  if (/(?:^|\n)Agent-authored:/im.test(body)) return true;
  return false;
}

export interface ContributorFlowDryRunContext {
  readonly workspaceId: string;
  readonly repo: string;
  readonly defaultBranch: string;
  readonly mode: ContributorFlowDryRun['mode'];
  readonly mergeMethod: 'merge' | 'squash' | 'rebase';
  readonly client: GitHubClient | null;
  readonly cachedPulls: ReadonlyArray<PrRecord>;
  readonly admission: AutomationAdmissionControl;
  readonly missingPermissions: ReadonlyArray<string>;
  readonly accounts: {
    readonly fetch: boolean;
    readonly runs: boolean;
    readonly pipelines: boolean;
    readonly webhooks: boolean;
  };
  readonly boardEnabled: boolean;
  readonly webhookConfigured: boolean;
  readonly webhookHealthy: boolean;
  readonly publicDeliveryReady: boolean;
}

export interface ContributorPullEvidence {
  readonly pull: GhPull;
  readonly cached: PrRecord | null;
  readonly observedAt: number;
}

interface LoadedAutonomyQueue {
  readonly pulls: ReadonlyArray<GhPull>;
  readonly openPullCount: number;
  readonly pullsComplete: boolean;
  readonly pullDetailsComplete: boolean;
  readonly issues: ReadonlyArray<GhIssue>;
  readonly openIssueCount: number;
  readonly issuesComplete: boolean;
  readonly error: string | null;
}

/**
 * Inspect a repository without starting a run, pipeline, webhook or GitHub
 * mutation. The 11th list page is a sentinel: it tells us the 1,000-item view
 * was cut instead of silently presenting a partial queue as complete.
 */
export async function buildContributorFlowDryRun(
  context: ContributorFlowDryRunContext,
): Promise<ContributorFlowDryRun> {
  const observedAt = Date.now();
  const checks: AutonomyReadinessCheck[] = capabilityChecks(context);
  if (!context.client) {
    checks.push(check(
      'source.github',
      'Live GitHub workload',
      'blocked',
      'No personal fetch account can read this repository, so Companion did not inspect cached titles or bodies.',
    ));
    return finish({
      context,
      observedAt,
      checks,
      source: {
        state: 'unavailable' as const,
        pullListComplete: false,
        issueListComplete: false,
        pullDetailsComplete: false,
        detailLimit: DETAIL_LIMIT,
        error: 'live GitHub access unavailable',
      },
      rateLimit: null,
      workload: emptyWorkload(),
      pulls: [],
    });
  }

  const [repoResult, protectionResult, queueResult] = await Promise.allSettled([
    context.client.repo(context.repo),
    context.client.branchProtection(context.repo, context.defaultBranch),
    context.client.repositoryAutonomyQueue(context.repo, {
      pullLimit: DETAIL_LIMIT,
      issueLimit: LIST_LIMIT,
    }),
  ]);
  let queue: LoadedAutonomyQueue;
  let fallbackReason: string | null = null;
  if (queueResult.status === 'fulfilled') {
    queue = {
      pulls: queueResult.value.pulls,
      openPullCount: queueResult.value.openPullCount,
      pullsComplete: queueResult.value.pullsComplete,
      pullDetailsComplete: queueResult.value.pullsComplete && queueResult.value.pulls.every(hasPullSize),
      issues: queueResult.value.issues,
      openIssueCount: queueResult.value.openIssueCount,
      issuesComplete: queueResult.value.issuesComplete,
      error: null,
    };
  } else {
    fallbackReason = safeError(queueResult.reason);
    queue = await loadRestFallback(context.client, context.repo);
  }
  if (fallbackReason) {
    checks.push(check(
      'source.graphql-fallback',
      'Efficient workload query',
      queue.error === null ? 'warning' : 'blocked',
      queue.error === null
        ? `The body-free GraphQL query was unavailable (${fallbackReason}); Companion used the bounded REST fallback.`
        : `Both the body-free GraphQL query and REST fallback failed: ${fallbackReason}; ${queue.error}`,
    ));
  }
  const sourceErrors = queue.error ? [queue.error] : [];
  const pullListComplete = queue.pullsComplete;
  const issueListComplete = queue.issuesComplete;
  const pullDetailsComplete = queue.pullDetailsComplete;
  const openPulls = queue.pulls;
  const openIssues = queue.issues;
  const cached = new Map(context.cachedPulls.map((pull) => [pull.number, pull]));
  const pullRows = openPulls.map((listed) =>
    classifyContributorPull({
      pull: listed,
      cached: currentCachedPull(cached.get(listed.number), listed),
      observedAt,
    }),
  );
  const workload = summarizeWorkload(openIssues, queue.openIssueCount, queue.openPullCount, pullRows);

  checks.push(check(
    'source.pull-coverage',
    'Pull request measurement',
    pullDetailsComplete ? 'pass' : 'blocked',
    pullDetailsComplete
      ? `Measured all ${queue.openPullCount} open pull requests from live GitHub data.`
      : `Measured ${pullRows.filter((pull) => pull.changedLines !== null).length} of ${queue.openPullCount || 'an unknown number of'} open pull requests; autonomous decisions must wait for complete size evidence.`,
  ));
  checks.push(check(
    'source.issue-coverage',
    'Issue intake measurement',
    issueListComplete ? 'pass' : 'blocked',
    issueListComplete
      ? `Observed all ${queue.openIssueCount} open issues in the bounded live listing.`
      : `Observed ${openIssues.length} of ${queue.openIssueCount || 'an unknown number of'} open issues; the 1,000-item intake ceiling was reached or GitHub failed.`,
  ));

  const repoInfo = repoResult.status === 'fulfilled' ? repoResult.value : null;
  const mergeEnabled = repoInfo === null
    ? null
    : context.mergeMethod === 'merge'
      ? repoInfo.allow_merge_commit !== false
      : context.mergeMethod === 'rebase'
        ? repoInfo.allow_rebase_merge !== false
        : repoInfo.allow_squash_merge !== false;
  checks.push(check(
    'governance.merge-method',
    'Configured merge method',
    mergeEnabled === false ? 'blocked' : mergeEnabled === null ? 'warning' : 'pass',
    mergeEnabled === false
      ? `${context.mergeMethod} merges are disabled by the repository.`
      : mergeEnabled === null
        ? 'Repository merge-method settings could not be read; verify them before enabling autonomous merge.'
        : `${context.mergeMethod} is available on the repository.`,
  ));

  const protection = protectionResult.status === 'fulfilled' ? protectionResult.value : null;
  appendProtectionChecks(checks, context.defaultBranch, protection);
  if (workload.atLeastTenThousandLines > 0 || workload.atLeastFiftyFiles > 0) {
    checks.push(check(
      'capacity.review-workload',
      'Review workload',
      'warning',
      `${workload.atLeastTenThousandLines} PR(s) exceed 10,000 changed lines and ${workload.atLeastFiftyFiles} touch at least 50 files; route outliers through map/split or bounded review before spending full-review capacity.`,
    ));
  } else {
    checks.push(check(
      'capacity.review-workload',
      'Review workload',
      'pass',
      `${workload.openPulls} open PR(s) fit the normal bounded-review envelope.`,
    ));
  }

  const rateLimit = context.client.rateLimitSnapshot();
  if (rateLimit) {
    const status = rateLimit.remaining === 0
      ? 'blocked'
      : rateLimit.remaining !== null && rateLimit.remaining < 100
        ? 'warning'
        : 'pass';
    checks.push(check(
      'capacity.github-rate-limit',
      'GitHub API budget',
      status,
      rateLimit.remaining === null
        ? 'GitHub did not expose a remaining primary-rate-limit value.'
        : `${rateLimit.remaining}${rateLimit.limit === null ? '' : ` of ${rateLimit.limit}`} requests remain${rateLimit.resetAt === null ? '' : ` until ${new Date(rateLimit.resetAt).toISOString()}`}.`,
    ));
  } else {
    checks.push(check(
      'capacity.github-rate-limit',
      'GitHub API budget',
      'warning',
      'No rate-limit headers were observed; long-running automation must treat capacity as unknown.',
    ));
  }

  return finish({
    context,
    observedAt,
    checks,
    source: {
      state: sourceErrors.length === 0 ? 'live' as const : 'unavailable' as const,
      pullListComplete,
      issueListComplete,
      pullDetailsComplete,
      detailLimit: DETAIL_LIMIT,
      error: sourceErrors.length > 0 ? sourceErrors.join('; ').slice(0, 1_000) : null,
    },
    rateLimit,
    workload,
    pulls: pullRows,
  });
}

/** Pure lane selection; exported so real repository fixtures can pin behavior. */
export function classifyContributorPull({ pull, cached, observedAt }: ContributorPullEvidence): ContributorPullDryRun {
  const changedLines = safeCount(pull.additions) === null || safeCount(pull.deletions) === null
    ? null
    : safeCount(pull.additions)! + safeCount(pull.deletions)!;
  const changedFiles = safeCount(pull.changed_files);
  const mergeability = pull.mergeable === true
    ? 'mergeable'
    : pull.mergeable === false || pull.mergeable_state === 'dirty'
      ? 'conflicting'
      : cached?.mergeable === true
        ? 'mergeable'
        : cached?.mergeable === false || cached?.mergeStateStatus === 'dirty'
          ? 'conflicting'
          : 'unknown';
  const checksCurrent = cached?.checks && cached.checks.fetchedAt >= observedAt - CURRENT_CHECKS_MS;
  const ci = checksCurrent ? cached.checks!.state : 'unknown';
  const reasons: string[] = [];
  if (pull.draft === true) reasons.push('draft pull request');
  if (mergeability === 'conflicting') reasons.push('branch conflict');
  if (ci === 'failing') reasons.push('failing CI');
  else if (ci === 'pending') reasons.push('CI still running');
  else if (ci === 'unknown') reasons.push('current CI evidence unavailable');
  if (changedLines === null || changedFiles === null) reasons.push('size evidence incomplete');
  else if (changedLines >= OVERSIZED_REVIEW_LINES || changedFiles >= OVERSIZED_REVIEW_FILES) {
    reasons.push('outside complete-review planning envelope');
  } else if (changedLines >= LARGE_REVIEW_LINES || changedFiles >= LARGE_REVIEW_FILES) {
    reasons.push('requires bounded multi-slice review');
  }

  let lane: ContributorPullLane;
  if (pull.draft === true) lane = 'wait-for-author';
  else if (mergeability === 'conflicting' || ci === 'failing') lane = 'repair-first';
  else if (changedLines === null || changedFiles === null || changedLines >= OVERSIZED_REVIEW_LINES || changedFiles >= OVERSIZED_REVIEW_FILES) {
    lane = 'map-and-split';
  } else if (changedLines >= LARGE_REVIEW_LINES || changedFiles >= LARGE_REVIEW_FILES) lane = 'bounded-review';
  else if (
    mergeability === 'mergeable' &&
    ci === 'passing' &&
    (pull.review_decision !== undefined ? pull.review_decision : cached?.reviewDecision) === 'approved' &&
    cached?.review === 'applied' &&
    cached.reviewRisk === 'low'
  ) {
    // This lane still revalidates complete head-pinned evidence before merge;
    // the lightweight PR cache deliberately cannot make that final claim.
    lane = 'evidence-gate';
    reasons.push('candidate for final head-pinned evidence gate');
  } else {
    lane = 'standard-review';
  }
  if (reasons.length === 0) reasons.push('normal bounded review path');

  return {
    number: pull.number,
    title: pull.title.slice(0, 500),
    url: pull.html_url,
    author: pull.user?.login ?? '',
    draft: pull.draft === true,
    // Body provenance has intentionally not appeared in any branch above and
    // therefore cannot choose the outcome.
    agentAuthored: agentAuthoredFromBody(pull.body),
    changedLines,
    changedFiles,
    mergeability,
    ci,
    lane,
    reasons,
  };
}

export function summarizeContributorWorkload(
  openIssues: readonly GhIssue[],
  openPullCount: number,
  pulls: readonly ContributorPullDryRun[],
): ContributorDryRunWorkload {
  return summarizeWorkload(openIssues, openIssues.length, openPullCount, pulls);
}

function capabilityChecks(context: ContributorFlowDryRunContext): AutonomyReadinessCheck[] {
  const checks: AutonomyReadinessCheck[] = [];
  checks.push(check(
    'access.rbac',
    'Companion permissions',
    context.missingPermissions.length === 0 ? 'pass' : 'blocked',
    context.missingPermissions.length === 0
      ? 'The profile has the complete issue, PR, run and Board capability bundle.'
      : `Missing ${context.missingPermissions.join(', ')}.`,
  ));
  const missingAccounts = Object.entries(context.accounts)
    .filter(([, available]) => !available)
    .map(([purpose]) => purpose);
  checks.push(check(
    'access.github-accounts',
    'Purpose-scoped GitHub accounts',
    missingAccounts.length === 0 ? 'pass' : 'blocked',
    missingAccounts.length === 0
      ? 'Fetch, runner, pipeline and webhook capabilities are available to this profile.'
      : `Missing usable ${missingAccounts.join(', ')} account capability.`,
  ));
  checks.push(check(
    'runtime.board',
    'Long-running task state machine',
    context.boardEnabled ? 'pass' : 'blocked',
    context.boardEnabled
      ? 'Task board is enabled for durable implementation, review, repair and merge stages.'
      : 'Task board is disabled; the end-to-end lifecycle cannot make durable progress.',
  ));
  checks.push(check(
    'runtime.webhook',
    'Signed webhook ingress',
    context.webhookConfigured && context.webhookHealthy && context.publicDeliveryReady ? 'pass' : 'blocked',
    !context.webhookConfigured
      ? 'No repository webhook is configured.'
      : !context.webhookHealthy
        ? 'The local receiver exists, but a healthy GitHub-side hook is not confirmed. Install or repair it before relying on immediate intake.'
        : !context.publicDeliveryReady
          ? 'The public delivery URL is not currently available.'
          : 'Signed public delivery is configured and healthy.',
  ));
  checks.push(check(
    'runtime.admission',
    'Background admission',
    context.admission.paused ? 'blocked' : 'pass',
    context.admission.paused
      ? `New background work is paused by ${context.admission.pausedBy ?? 'an operator'}: ${context.admission.reason ?? 'no reason recorded'}. Existing durable work may drain.`
      : 'New signed deliveries and automatic schedules may be admitted.',
  ));
  return checks;
}

function appendProtectionChecks(
  checks: AutonomyReadinessCheck[],
  branch: string,
  protection: Awaited<ReturnType<GitHubClient['branchProtection']>>,
): void {
  if (!protection) {
    checks.push(check(
      'governance.branch-protection',
      `${branch} branch protection`,
      'warning',
      'Protection is absent or unreadable. Companion still fails its own gates closed, but repository-level enforcement is not proven.',
    ));
    return;
  }
  checks.push(check(
    'governance.required-checks',
    'Required CI contexts',
    protection.requiredContexts.length > 0 ? 'pass' : 'warning',
    protection.requiredContexts.length > 0
      ? `${protection.requiredContexts.length} required context(s): ${protection.requiredContexts.slice(0, 8).join(', ')}${protection.requiredContexts.length > 8 ? ', …' : ''}.`
      : 'No required status context protects the base branch.',
  ));
  checks.push(check(
    'governance.strict-checks',
    'Up-to-date branch requirement',
    protection.requiredContexts.length > 0 && protection.strict ? 'pass' : 'warning',
    protection.requiredContexts.length === 0
      ? 'There are no required contexts whose result can be pinned to an up-to-date base branch.'
      : protection.strict
        ? 'Required status checks must run on a branch that is current with the base branch.'
        : 'GitHub allows required checks from a branch that is behind the base branch.',
  ));
  checks.push(check(
    'governance.admin-enforcement',
    'Administrator enforcement',
    protection.enforceAdmins ? 'pass' : 'warning',
    protection.enforceAdmins
      ? 'Repository administrators are subject to the branch-protection rules.'
      : 'Repository administrators may bypass these branch-protection rules; Companion still applies its own live gates.',
  ));
  checks.push(check(
    'governance.required-review',
    'Required human review',
    protection.requiredApprovingReviews > 0 ? 'pass' : 'warning',
    protection.requiredApprovingReviews > 0
      ? `${protection.requiredApprovingReviews} approving review(s) are enforced by GitHub.`
      : 'GitHub does not enforce an approving review; governed mode still stops at a human decision inside Companion.',
  ));
  if (protection.requiredApprovingReviews > 0) {
    checks.push(check(
      'governance.review-freshness',
      'Review freshness',
      protection.dismissStaleReviews ? 'pass' : 'warning',
      `${protection.dismissStaleReviews ? 'Approvals are dismissed' : 'Approvals remain valid'} after new commits.` +
        `${protection.requireCodeOwnerReviews ? ' Code-owner review is required.' : ' Code-owner review is not required.'}`,
    ));
  }
  checks.push(check(
    'governance.conversations',
    'Conversation resolution',
    protection.requireConversationResolution ? 'pass' : 'warning',
    protection.requireConversationResolution
      ? 'Review conversations must be resolved before merge.'
      : 'Unresolved review conversations do not block a GitHub merge.',
  ));
  checks.push(check(
    'governance.force-push',
    'Force-push protection',
    protection.allowForcePushes ? 'warning' : 'pass',
    protection.allowForcePushes
      ? 'Force-pushes are allowed on the base branch; evidence freshness needs extra operational discipline.'
      : 'Force-pushes are disabled on the base branch.',
  ));
}

function summarizeWorkload(
  openIssues: readonly GhIssue[],
  openIssueCount: number,
  openPullCount: number,
  pulls: readonly ContributorPullDryRun[],
): ContributorDryRunWorkload {
  const knownLines = pulls
    .map((pull) => pull.changedLines)
    .filter((lines): lines is number => lines !== null)
    .sort((a, b) => a - b);
  const laneCount = (lane: ContributorPullLane): number => pulls.filter((pull) => pull.lane === lane).length;
  const ciCount = (state: ContributorPullDryRun['ci']): number => pulls.filter((pull) => pull.ci === state).length;
  return {
    openIssues: openIssueCount,
    unlabelledIssues: openIssues.filter((issue) => issue.labels.length === 0).length,
    unassignedIssues: openIssues.filter((issue) => (issue.assignees?.length ?? 0) === 0).length,
    openPulls: openPullCount,
    measuredPulls: knownLines.length,
    drafts: pulls.filter((pull) => pull.draft).length,
    agentAuthored: pulls.filter((pull) => pull.agentAuthored).length,
    conflicting: pulls.filter((pull) => pull.mergeability === 'conflicting').length,
    knownChangedLines: knownLines.reduce((sum, lines) => sum + lines, 0),
    medianChangedLines: knownLines.length === 0 ? null : knownLines[Math.floor(knownLines.length / 2)]!,
    atLeastOneThousandLines: pulls.filter((pull) => (pull.changedLines ?? -1) >= 1_000).length,
    atLeastTenThousandLines: pulls.filter((pull) => (pull.changedLines ?? -1) >= 10_000).length,
    atLeastFiftyFiles: pulls.filter((pull) => (pull.changedFiles ?? -1) >= 50).length,
    ciPassing: ciCount('passing'),
    ciFailing: ciCount('failing'),
    ciPending: ciCount('pending'),
    ciUnknown: ciCount('unknown') + ciCount('none'),
    lanes: {
      waitForAuthor: laneCount('wait-for-author'),
      repairFirst: laneCount('repair-first'),
      mapAndSplit: laneCount('map-and-split'),
      boundedReview: laneCount('bounded-review'),
      standardReview: laneCount('standard-review'),
      evidenceGate: laneCount('evidence-gate'),
    },
  };
}

/** Older GHES fallback. Still bounded, but intentionally reported because it
 * costs one detail request per measured PR instead of one body-free query. */
async function loadRestFallback(client: GitHubClient, repo: string): Promise<LoadedAutonomyQueue> {
  const [pullsResult, issuesResult] = await Promise.allSettled([
    client.pulls(repo, LIST_PROBE_PAGES, 'open'),
    client.issues(repo, { state: 'open', maxPages: LIST_PROBE_PAGES }),
  ]);
  const errors = [pullsResult, issuesResult]
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => safeError(result.reason));
  const rawPulls = pullsResult.status === 'fulfilled' ? pullsResult.value : [];
  const rawIssues = issuesResult.status === 'fulfilled' ? issuesResult.value : [];
  const listedPulls = rawPulls.slice(0, DETAIL_LIMIT);
  const detailRows = await mapConcurrent(listedPulls, DETAIL_CONCURRENCY, async (pull) => {
    try {
      return await client.pull(repo, pull.number);
    } catch {
      return pull;
    }
  });
  const openIssues = rawIssues
    .slice(0, LIST_LIMIT)
    .filter((issue) => !issue.pull_request && issue.state === 'open');
  const pullsComplete = pullsResult.status === 'fulfilled' && rawPulls.length <= DETAIL_LIMIT;
  return {
    pulls: detailRows,
    openPullCount: rawPulls.length,
    pullsComplete,
    pullDetailsComplete: pullsComplete && detailRows.every(hasPullSize),
    issues: openIssues,
    openIssueCount: openIssues.length,
    issuesComplete: issuesResult.status === 'fulfilled' && rawIssues.length <= LIST_LIMIT,
    error: errors.length > 0 ? errors.join('; ').slice(0, 1_000) : null,
  };
}

function hasPullSize(pull: GhPull): boolean {
  return safeCount(pull.additions) !== null &&
    safeCount(pull.deletions) !== null &&
    safeCount(pull.changed_files) !== null;
}

function currentCachedPull(cached: PrRecord | undefined, listed: GhPull): PrRecord | null {
  if (!cached) return null;
  return cached.headSha === (listed.head.sha ?? null) ? cached : null;
}

function safeCount(value: number | undefined): number | null {
  return Number.isSafeInteger(value) && value! >= 0 ? value! : null;
}

function emptyWorkload(): ContributorDryRunWorkload {
  return {
    openIssues: 0,
    unlabelledIssues: 0,
    unassignedIssues: 0,
    openPulls: 0,
    measuredPulls: 0,
    drafts: 0,
    agentAuthored: 0,
    conflicting: 0,
    knownChangedLines: 0,
    medianChangedLines: null,
    atLeastOneThousandLines: 0,
    atLeastTenThousandLines: 0,
    atLeastFiftyFiles: 0,
    ciPassing: 0,
    ciFailing: 0,
    ciPending: 0,
    ciUnknown: 0,
    lanes: {
      waitForAuthor: 0,
      repairFirst: 0,
      mapAndSplit: 0,
      boundedReview: 0,
      standardReview: 0,
      evidenceGate: 0,
    },
  };
}

function finish(input: {
  readonly context: ContributorFlowDryRunContext;
  readonly observedAt: number;
  readonly checks: ReadonlyArray<AutonomyReadinessCheck>;
  readonly source: ContributorFlowDryRun['source'];
  readonly rateLimit: ContributorFlowDryRun['rateLimit'];
  readonly workload: ContributorDryRunWorkload;
  readonly pulls: ReadonlyArray<ContributorPullDryRun>;
}): ContributorFlowDryRun {
  const status = input.checks.some((item) => item.status === 'blocked')
    ? 'blocked'
    : input.checks.some((item) => item.status === 'warning')
      ? 'attention'
      : 'ready';
  return {
    repo: input.context.repo,
    workspaceId: input.context.workspaceId,
    mode: input.context.mode,
    observedAt: input.observedAt,
    status,
    dryRun: true,
    githubMutations: 0,
    agentRuns: 0,
    source: input.source,
    rateLimit: input.rateLimit,
    checks: input.checks,
    workload: input.workload,
    pulls: input.pulls,
  };
}

function check(
  id: string,
  label: string,
  status: AutonomyReadinessCheck['status'],
  detail: string,
): AutonomyReadinessCheck {
  return { id, label, status, detail };
}

function safeError(error: unknown): string {
  return String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').slice(0, 500);
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
