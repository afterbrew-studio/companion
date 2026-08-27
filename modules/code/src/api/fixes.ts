import { log } from '@moxxy/companion-sdk/server';
import type { Permission, SpaServerMessage } from '@moxxy/companion-contracts';
import type { PromptAttachment } from '@moxxy/companion-sdk/agents';
import type { RunRecord, RunRoutingContext } from '@companion/module-operate/contract';
import { isRunnerUnavailable } from '@companion/module-operate/contract';
import type { PrRecord, RepoAgentContext } from '../contract/index.js';
import type { CodeStore } from './code-store.js';
import type { Orchestrator, RunnerBackend } from './operate-types.js';
import type { GitHubClient } from './github-client.js';
import type { PrChecks } from './pr-checks.js';
import {
  mergePullRequestBody,
  primaryPullRequestTemplate,
  pullRequestSummary,
  pullRequestTitle,
  repositoryBranchPrefix,
  repositoryGuidancePrompt,
  type RepoAgentContextScanner,
} from './repo-agent-context.js';

/**
 * Dispatch context a caller attaches to a fix run: which registered unit of
 * work it counts as, and the model chosen for that unit. Both outlive the
 * individual run: a board card spawns build, CI-repair and review-fix runs
 * over days, which is why the model is a preference and not a hard choice.
 */
export interface FixRunOptions {
  /** Feature task id for runner filtering (e.g. 'board.worker'). */
  task?: string;
  /** Outranks the task's instance pin; gives way like one where the machine the
   *  run lands on cannot serve it. */
  preferredModel?: string | null;
  /** Semantic stage and parent work unit for Model Router. */
  routing?: RunRoutingContext;
  /** Internal owning-flow hooks: expose the child before its first prompt. */
  onCreated?: (runId: string) => void;
  /** Final cancellation fence after run creation and before every first-turn action. */
  shouldStart?: (runId: string) => boolean;
}

/**
 * Fix-to-PR flows: a goal-mode agent works in a dedicated worktree; the human
 * reviews the diff; companiond (never the agent) pushes. Two shapes:
 * fresh-branch runs (fix an issue, implement a proposal) open a NEW PR on
 * approval; PR-branch runs (repair failing checks, address review feedback)
 * continue an EXISTING PR's branch and push straight to it.
 *
 * The worktree lives on the run's placed runner (local or remote): placement
 * happens up front, the worktree + clone are prepared through that runner's
 * backend, and diff/commit/push route back to the same backend so the whole
 * fix executes on one machine.
 */
export class Fixes {
  constructor(
    private readonly store: CodeStore,
    private readonly orchestrator: Orchestrator,
    private readonly github: (repo?: string, username?: string | null) => GitHubClient | null,
    private readonly verifyGithub: (repo: string, username: string) => Promise<boolean>,
    /** Account that may actually PUSH to the repo — resolved once per approval
     *  so the branch and the PR it opens come from the same identity. */
    private readonly pushClient: (
      repo: string,
      username: string,
    ) => Promise<{ client: GitHubClient | null; tried: string[] }>,
    private readonly authorized: (username: string, permission: Permission, repo: string) => boolean,
    private readonly checks: PrChecks,
    private readonly agentContext: RepoAgentContextScanner,
    private readonly broadcast: (msg: SpaServerMessage) => void,
  ) {}

  /** Backend a completed/queued run's worktree lives on. */
  private backendForRun(runnerId: string | null): RunnerBackend {
    return this.orchestrator.runners.backend(runnerId);
  }

  /**
   * `createRun`, with the worktree released when the run is refused outright.
   *
   * Both goal-run paths place a runner, then fetch and add a worktree, then
   * create the run - so `createRun` re-takes the placement decision, which can
   * refuse. A refusal leaves a worktree no run will ever own, reclaimable only
   * by storage cleanup.
   *
   * Only a refusal releases it. `createRun` can also throw AFTER inserting the
   * row - a spawn failure marks the run `failed` and rethrows - and that run
   * owns its worktree: `discard` and any diff against it still need the
   * directory to be there.
   */
  private async createRunOrReleaseWorktree(
    runnerId: string | null,
    repo: string,
    cwd: string,
    opts: Parameters<Orchestrator['createRun']>[0],
  ): Promise<RunRecord> {
    try {
      return await this.orchestrator.createRun({ ...opts, placedAhead: true });
    } catch (err) {
      if (isRunnerUnavailable(err)) {
        await this.backendForRun(runnerId).removeWorktree(repo, cwd).catch(() => undefined);
      }
      throw err;
    }
  }

  async startFix(repo: string, issueNumber: number, userId: string | null = null): Promise<RunRecord> {
    const issue = this.store.issues.get(repo, issueNumber);
    if (!issue) throw new Error(`unknown issue ${repo}#${issueNumber}`);
    const repoRow = this.store.repos.get(repo);
    if (!repoRow) throw new Error(`unknown repo ${repo}`);

    const run = await this.createGoalRun({
      kind: 'fix',
      title: `Fix #${issueNumber}: ${issue.title.slice(0, 60)}`,
      repo,
      issueNumber,
      branchPrefix: `companion/issue-${issueNumber}`,
      baseBranch: repoRow.default_branch,
      objective: fixObjective(issue.title, issue.body, issueNumber, repoRow.default_branch),
      userId,
    });
    return run;
  }

  /**
   * Shared goal-run bootstrap for fixes and proposal implementations: place →
   * ensure clone + worktree on the chosen runner → run with cwd=worktree →
   * goal mode → objective prompt.
   */
  async createGoalRun(opts: {
    kind: 'fix' | 'implement';
    title: string;
    repo: string;
    issueNumber?: number | null;
    proposalId?: string | null;
    branchPrefix: string;
    baseBranch: string;
    objective: string;
    attachments?: readonly PromptAttachment[];
    /** Triggering user — unlocks their personal runners for placement. */
    userId?: string | null;
    /** See FixRunOptions; `task` defaults by kind when omitted. */
    task?: string;
    preferredModel?: string | null;
    routing?: RunRoutingContext;
    onCreated?: (runId: string) => void;
    shouldStart?: (runId: string) => boolean;
  }): Promise<RunRecord> {
    this.requireRunAuthority(opts.repo, opts.userId);
    await this.requirePersonalAccess(opts.repo, opts.userId);
    const context = await this.loadAgentContext(opts.repo, opts.baseBranch, opts.userId);
    const suffix = Date.now().toString(36).slice(-4);
    const branchPrefix = repositoryBranchPrefix(opts.branchPrefix, opts.title, opts.kind, context);
    const branch = `${branchPrefix}-${suffix}`;
    const task = opts.task ?? (opts.kind === 'fix' ? 'code.fix' : 'code.implement');
    const routing = opts.routing ?? {
      phase: 'implement',
      workUnitId: opts.proposalId ?? (opts.issueNumber ? `${opts.repo}#${opts.issueNumber}` : opts.branchPrefix),
      risk: 'medium' as const,
    };
    const placement = this.orchestrator.prepareRunPlacement(opts.repo, {
      kind: opts.kind,
      userId: opts.userId,
      task,
      preferredModel: opts.preferredModel,
      routing,
    });
    const runnerId = placement.runnerId;
    const backend = this.backendForRun(runnerId);
    await backend.ensureClone(opts.repo, opts.userId);
    const cwd = await backend.addWorktree(
      opts.repo,
      `${opts.kind}-${suffix}-${Math.random().toString(36).slice(2, 8)}`,
      branch,
      opts.baseBranch,
      opts.userId,
    );

    // The runner was chosen before the clone above, and createRun re-checks that
    // it still has a slot. Losing that race leaves a worktree nothing will ever
    // own, so it is removed here rather than waiting for storage cleanup.
    const run = await this.createRunOrReleaseWorktree(runnerId, opts.repo, cwd, {
      kind: opts.kind,
      title: opts.title,
      runnerId,
      cwd,
      repo: opts.repo,
      issueNumber: opts.issueNumber ?? null,
      proposalId: opts.proposalId ?? null,
      branch,
      userId: opts.userId ?? null,
      task,
      preferredModel: opts.preferredModel,
      routing,
      routingResolution: placement.routingResolution,
    });

    try {
      opts.onCreated?.(run.id);
    } catch (err) {
      await this.orchestrator.stopRun(run.id).catch(() => undefined);
      throw new Error(`goal-run owner callback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const mayStart = (): boolean => {
      try {
        return this.hasRunAuthority(opts.userId, opts.repo) && opts.shouldStart?.(run.id) !== false;
      } catch {
        return false;
      }
    };
    if (!mayStart()) {
      await this.orchestrator.stopRun(run.id);
      return this.orchestrator.getRun(run.id)!;
    }

    await this.orchestrator.setGoalMode(run.id);
    if (!mayStart()) {
      await this.orchestrator.stopRun(run.id);
      return this.orchestrator.getRun(run.id)!;
    }
    await this.orchestrator.sendPrompt(
      run.id,
      `${opts.objective}\n\n${repositoryGuidancePrompt(context)}`,
      undefined,
      opts.attachments,
    );
    return this.orchestrator.getRun(run.id)!;
  }

  // ---------- PR-branch repair runs -----------------------------------------------

  /** Agent repairs the failing CI on a PR, working directly on its branch. */
  async startCheckFix(
    repo: string,
    prNumber: number,
    userId: string | null = null,
    opts: FixRunOptions = {},
  ): Promise<RunRecord> {
    await this.requirePersonalAccess(repo, userId);
    const { pr } = this.requireOpenPr(repo, prNumber, userId);
    const summary = await this.checks.fetchSummary(repo, prNumber, userId!);
    const failing = summary.runs.filter(
      (r) => r.status === 'completed' && r.conclusion !== 'success' && r.conclusion !== 'neutral' && r.conclusion !== 'skipped',
    );
    if (failing.length === 0) throw new Error('no failing checks on this PR');
    // Same reason as the post-mortem: handing the agent the error it is about to
    // go looking for saves it a full local reproduction, and a repair run is the
    // more expensive of the two to waste.
    const logs = pr.headSha
      ? ((await this.github(repo, userId)?.failingJobLogs(repo, pr.headSha).catch(() => [])) ?? [])
      : [];
    return this.createPrBranchRun(
      pr,
      `Fix CI on PR #${prNumber}: ${pr.title.slice(0, 50)}`,
      checkFixObjective(pr, failing, logs),
      { ...opts, userId },
    );
  }

  /** Agent implements the changes human reviewers asked for on a PR. */
  async startReviewFix(
    repo: string,
    prNumber: number,
    userId: string | null = null,
    opts: FixRunOptions = {},
  ): Promise<RunRecord> {
    await this.requirePersonalAccess(repo, userId);
    const { pr, client } = this.requireOpenPr(repo, prNumber, userId);
    const [reviewPage, inline] = await Promise.all([
      client.prReviewList(repo, prNumber),
      client.prReviewComments(repo, prNumber).catch(() => []),
    ]);
    const feedback = reviewPage.reviews
      .filter((r) => (r.state === 'CHANGES_REQUESTED' || r.state === 'COMMENTED') && r.body?.trim())
      .map((r) => `Review by ${r.user?.login ?? 'reviewer'} (${r.state}):\n${r.body!.trim()}`);
    const comments = inline.map(
      (c) => `- ${c.path}:${c.line ?? c.original_line ?? '?'} (${c.user?.login ?? 'reviewer'}): ${c.body.trim()}`,
    );
    if (feedback.length === 0 && comments.length === 0) {
      throw new Error('no human review feedback found on this PR');
    }
    return this.createPrBranchRun(
      pr,
      `Address reviews on PR #${prNumber}: ${pr.title.slice(0, 45)}`,
      reviewFixObjective(pr, feedback, comments),
      { ...opts, userId },
    );
  }

  /** Agent merges the fresh base into the PR branch and resolves the conflicts. */
  async startConflictResolve(
    repo: string,
    prNumber: number,
    userId: string | null = null,
    opts: FixRunOptions = {},
  ): Promise<RunRecord> {
    await this.requirePersonalAccess(repo, userId);
    const { pr, client } = this.requireOpenPr(repo, prNumber, userId);
    // Re-check GitHub live — the sync cache can lag a manual resolution, and a
    // run launched then would push a pointless no-op merge commit. Fail open on
    // fetch trouble: the run itself discovers "already up to date".
    const live = await client.pull(repo, prNumber).catch(() => null);
    if (live && live.mergeable !== undefined) {
      this.store.prs.setMergeable(repo, prNumber, live.mergeable);
      this.broadcast({ t: 'prs.changed', repo });
      if (live.mergeable === true) throw new Error('GitHub reports no merge conflicts on this PR');
    }
    return this.createPrBranchRun(
      pr,
      `Resolve conflicts on PR #${prNumber}: ${pr.title.slice(0, 45)}`,
      conflictObjective(pr),
      { ...opts, userId },
    );
  }

  /** Agent works on the PR branch with a user-written objective. */
  async startCustomPrRun(repo: string, prNumber: number, instructions: string, userId: string | null = null): Promise<RunRecord> {
    await this.requirePersonalAccess(repo, userId);
    const { pr } = this.requireOpenPr(repo, prNumber, userId);
    const preview = instructions.trim().split('\n')[0]!.slice(0, 50);
    return this.createPrBranchRun(pr, `Agent on PR #${prNumber}: ${preview}`, customObjective(pr, instructions), {
      userId,
    });
  }

  private requireOpenPr(
    repo: string,
    prNumber: number,
    username?: string | null,
  ): { pr: PrRecord; client: GitHubClient } {
    const pr = this.store.prs.get(repo, prNumber);
    if (!pr) throw new Error(`unknown PR ${repo}#${prNumber}`);
    if (pr.state !== 'open') throw new Error(`PR #${prNumber} is ${pr.state}`);
    if (!pr.headRef) throw new Error('PR has no head branch');
    const client = this.github(repo, username);
    if (!client) throw new Error('GitHub is not configured');
    return { pr, client };
  }

  /** Worktree AT the PR head; the run carries the PR so approve pushes to it. */
  private async createPrBranchRun(
    pr: PrRecord,
    title: string,
    objective: string,
    opts: FixRunOptions & { userId?: string | null } = {},
  ): Promise<RunRecord> {
    this.requireRunAuthority(pr.repo, opts.userId);
    await this.requirePersonalAccess(pr.repo, opts.userId);
    const context = await this.loadAgentContext(pr.repo, pr.baseRef, opts.userId);
    const suffix = `${Date.now().toString(36).slice(-4)}-${Math.random().toString(36).slice(2, 8)}`;
    const task = opts.task ?? 'code.fix';
    const routing = opts.routing ?? {
      phase: 'repair',
      workUnitId: `${pr.repo}#${pr.number}`,
      risk: 'medium' as const,
    };
    const placement = this.orchestrator.prepareRunPlacement(pr.repo, {
      kind: 'fix',
      userId: opts.userId,
      task,
      preferredModel: opts.preferredModel,
      routing,
    });
    const runnerId = placement.runnerId;
    const backend = this.backendForRun(runnerId);
    await backend.ensureClone(pr.repo, opts.userId);
    // The objective inspects the full PR locally; refresh the base and head refs
    // before creating the worktree so a large diff never needs prompt embedding.
    await backend.fetchOrigin(pr.repo, opts.userId);
    let cwd: string;
    try {
      cwd = await backend.addWorktreeAtBranch(pr.repo, `prfix-${suffix}`, pr.headRef, opts.userId);
    } catch (err) {
      // Only the checkout step earns the fork-branch diagnosis — clone/fetch
      // failures surface raw so a network blip isn't mislabelled.
      throw new Error(
        `could not check out ${pr.headRef} from origin — fork-branch PRs are not supported yet (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`,
      );
    }
    const run = await this.createRunOrReleaseWorktree(runnerId, pr.repo, cwd, {
      kind: 'fix',
      title,
      runnerId,
      cwd,
      repo: pr.repo,
      issueNumber: pr.number,
      branch: pr.headRef,
      userId: opts.userId ?? null,
      task,
      preferredModel: opts.preferredModel,
      routing,
      routingResolution: placement.routingResolution,
    });
    try {
      opts.onCreated?.(run.id);
    } catch (err) {
      await this.orchestrator.stopRun(run.id).catch(() => undefined);
      throw new Error(`fix-run owner callback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const mayStart = (): boolean => {
      try {
        return this.hasRunAuthority(opts.userId, pr.repo) && opts.shouldStart?.(run.id) !== false;
      } catch {
        return false;
      }
    };
    if (!mayStart()) {
      await this.orchestrator.stopRun(run.id);
      return this.orchestrator.getRun(run.id)!;
    }
    // The existing PR is this run's destination; approve() pushes to its
    // branch instead of opening a new one.
    this.store.runs.setPr(run.id, pr.headRef, pr.url);
    await this.orchestrator.setGoalMode(run.id);
    if (!mayStart()) {
      await this.orchestrator.stopRun(run.id);
      return this.orchestrator.getRun(run.id)!;
    }
    await this.orchestrator.sendPrompt(run.id, `${objective}\n\n${repositoryGuidancePrompt(context)}`);
    return this.orchestrator.getRun(run.id)!;
  }

  async diff(runId: string, baseBranch?: string): Promise<{ diff: string; branch: string | null }> {
    const run = this.store.runs.get(runId);
    if (!run || !run.repo) throw new Error('run not found or not a repo run');
    const repoRow = this.store.repos.get(run.repo);
    // PR-branch runs diff against the PR head (only the agent's delta);
    // fresh-branch runs diff against the default branch.
    const base = run.pr_url && run.branch ? run.branch : (baseBranch ?? repoRow?.default_branch ?? 'main');
    const diff = await this.backendForRun(run.runner_id).diffVsBase(run.cwd, base);
    return { diff, branch: run.branch };
  }

  /**
   * Human approved the diff: commit leftovers and push. Runs bound to an
   * existing PR stop there; fresh-branch runs open the PR.
   */
  async approve(
    runId: string,
    opts: { title?: string; body?: string; baseBranch?: string; beforeWrite?: () => void } = {},
    actorUsername?: string | null,
  ): Promise<{ prUrl: string }> {
    const run = this.store.runs.get(runId);
    if (!run || !run.repo || !run.branch) throw new Error('run not found or has no branch');
    const repoRow = this.store.repos.get(run.repo);
    if (!repoRow) throw new Error(`unknown repo ${run.repo}`);
    // An interactive approver acts as themselves, never as the user who
    // originally created the run. Internal continuations omit the override and
    // remain bound to the persisted run owner.
    const credentialOwner = actorUsername === undefined ? run.user_id : actorUsername;
    // Write access is settled BEFORE anything is committed or pushed: a
    // read-only account would otherwise reach git and fail with GitHub's
    // opaque 403 after the agent already did all the work.
    const client = await this.requirePushAccess(run.repo, credentialOwner);

    const backend = this.backendForRun(run.runner_id);
    // Signed as the account whose credential is about to push it, so the commit
    // attributes to a real GitHub user instead of a local identity nobody can
    // resolve. Best effort: a failed lookup keeps the previous behaviour rather
    // than losing work the agent already did.
    const author = await client
      .viewer()
      .then(({ login }) => ({ name: login, email: `${login}@users.noreply.github.com` }))
      .catch(() => undefined);
    const baseBranch = opts.baseBranch ?? repoRow.default_branch;
    const context = await this.loadAgentContext(run.repo, baseBranch, credentialOwner);
    const title = pullRequestTitle(
      run.title,
      run.outcome,
      opts.title,
      context.policies.conventionalPrTitle,
    );
    opts.beforeWrite?.();
    // Fresh PRs are collapsed onto their trusted base before Companion creates
    // one clean commit. This removes any attribution trailer even if a harness
    // ignored the no-commit prompt. Existing PR repairs retain their topology.
    await backend.commitAll(run.cwd, title, author, run.pr_url ? undefined : baseBranch);
    opts.beforeWrite?.();
    await backend.push(run.repo, run.cwd, run.branch, credentialOwner);

    if (run.pr_url) {
      this.orchestrator.markRun(runId, 'completed', `pushed to ${run.branch} (${run.pr_url})`);
      await this.orchestrator.stopRun(runId).catch(() => undefined);
      this.broadcast({ t: 'runs.changed' });
      this.broadcast({ t: 'prs.changed', repo: run.repo });
      return { prUrl: run.pr_url };
    }

    opts.beforeWrite?.();
    const generatedBody =
      opts.body ??
      `${pullRequestSummary(run.outcome)}\n\n${run.issue_number ? `Closes #${run.issue_number}.` : ''}`.trim();
    const pr = await client.createPr(run.repo, {
      title,
      head: run.branch,
      base: baseBranch,
      body: mergePullRequestBody(primaryPullRequestTemplate(context), generatedBody),
      draft: context.policies.pullRequestDraft,
    });

    this.store.runs.setPr(runId, run.branch, pr.html_url);

    // Which model wrote this. A reviewer reading the diff cannot otherwise tell
    // a frontier attempt from a cheap one, and the two deserve different
    // scepticism - a label is the cheapest way to carry that, and it survives on
    // the pull request after the run's own record has aged out.
    //
    // Best effort: a label is not worth failing a pull request that already
    // exists, and the model is also recorded on the run.
    if (run.model) {
      await client
        .addLabels(run.repo, prNumberFromUrl(pr.html_url) ?? 0, [`model:${run.model}`])
        .catch((err) => log.warn('could not label the pull request with its model', {
          repo: run.repo,
          model: run.model,
          err: String(err),
        }));
    }

    this.orchestrator.markRun(runId, 'completed', `PR opened: ${pr.html_url}`);
    // Stop the gateway; the worktree stays for post-merge cleanup.
    await this.orchestrator.stopRun(runId).catch(() => undefined);
    this.store.runs.updateStatus(runId, 'completed');
    this.broadcast({ t: 'runs.changed' });
    return { prUrl: pr.html_url };
  }

  /** Human rejected the work: stop the run and drop the worktree. */
  async discard(runId: string): Promise<void> {
    const run = this.store.runs.get(runId);
    if (!run) throw new Error('run not found');
    await this.orchestrator.stopRun(runId).catch(() => undefined);
    if (run.repo && run.cwd.includes('worktrees')) {
      await this.backendForRun(run.runner_id).removeWorktree(run.repo, run.cwd).catch(() => undefined);
    }
    this.orchestrator.markRun(runId, 'abandoned', 'discarded by user');
  }

  private async requirePersonalAccess(repo: string, username?: string | null): Promise<void> {
    if (!username || !(await this.verifyGithub(repo, username))) {
      throw new Error(`your GitHub accounts cannot access ${repo} — ask the repository owner to grant access`);
    }
  }

  private async loadAgentContext(
    repo: string,
    ref: string,
    username?: string | null,
  ): Promise<RepoAgentContext> {
    const client = this.github(repo, username);
    if (!client) throw new Error(`GitHub is not configured for ${repo}; repository guidance cannot be verified`);
    return this.agentContext.scan(client, repo, ref);
  }

  private hasRunAuthority(username: string | null | undefined, repo: string): boolean {
    return Boolean(
      username &&
      this.authorized(username, 'runs:read', repo) &&
      this.authorized(username, 'runs:act', repo),
    );
  }

  private requireRunAuthority(repo: string, username?: string | null): void {
    if (!this.hasRunAuthority(username, repo)) {
      throw new Error(`${username ?? 'this profile'} is disabled, cannot access ${repo}, or no longer holds runs:read and runs:act`);
    }
  }

  /** The client of an account that may push here, or a diagnosis naming the
   *  accounts that were tried and rejected. */
  private async requirePushAccess(repo: string, username?: string | null): Promise<GitHubClient> {
    if (!username) throw new Error(`no GitHub account owner for ${repo} — the run has no owning profile`);
    const { client, tried } = await this.pushClient(repo, username);
    if (!client) {
      throw new Error(
        `no connected GitHub account can push to ${repo}` +
          (tried.length ? ` (tried ${tried.join(', ')})` : '') +
          ' — grant that account write access, or connect one that has it',
      );
    }
    return client;
  }
}

/**
 * The scope contract, appended to every objective that runs on a PR branch.
 *
 * `buildObjective` on the board carries its own copy for the implement stage.
 * These four - CI repair, review fixes, conflicts, and a maintainer's own
 * instruction - had none, and the difference was not academic: a CI-repair run
 * asked to make a check pass edited two GitHub Actions workflows on a pull
 * request about a documentation file, because "make CI pass" without a boundary
 * admits changing whatever is making it fail.
 *
 * The marker matches what the board's escalation reads, so a question here parks
 * the card and asks a person exactly as it does at the build stage.
 */
const SCOPE_AND_ESCALATION = `
## Scope
This pull request has an intent, and it is the boundary of your work.

- Change ONLY what the job above requires. Nothing else in the repository is yours to touch, however obviously it could be improved.
- Do not edit CI configuration, workflows, build or lint settings to make a check pass. A check that fails is evidence about the code; changing the check hides it. If the only way to pass is to change how it is enforced, that is a decision for a person.
- Do not rename, restructure or reformat code the job does not require.
- Do not add dependencies, abstractions or tests the job does not require.
- Mention unrelated problems you notice in your summary. Do not fix them.

## When you cannot proceed without deciding something
If finishing would require a choice this job does not settle - which behaviour is
wanted, whether a check is even correct, which of two readings applies - then:

1. Make NO changes. Leave the worktree exactly as you found it.
2. End your turn with a single line starting \`NEEDS-HUMAN:\` and the question, stated so someone who has not read the code can answer it. Say what you would have done and why you are not doing it.

Asking costs a reply. Guessing costs a change that has to be found and undone.`;

function checkFixObjective(
  pr: PrRecord,
  failing: ReadonlyArray<{ name: string; conclusion: string | null; detailsUrl: string | null }>,
  logs: ReadonlyArray<{ name: string; log: string }>,
): string {
  const list = failing
    .map((f) => `- ${f.name}: ${f.conclusion ?? 'failed'}${f.detailsUrl ? ` (${f.detailsUrl})` : ''}`)
    .join('\n');
  const logSection = logs.length
    ? `\n## Job logs (tail of each failing job)\n${logs
        .map((l) => `### ${l.name}\n\`\`\`\n${l.log}\n\`\`\``)
        .join('\n\n')}\n`
    : '';
  return `You are an autonomous software engineer working in a git worktree checked out AT the head of pull request #${pr.number} ("${pr.title}", branch ${pr.headRef}). The PR's CI is failing; your job is to make it pass without changing what the PR intends to do.

## Failing pipelines
${list}
${logSection}
${prDiffInspectionGuide(pr.baseRef)}

## Rules
- Work ONLY inside this worktree, on this branch.
- Start from the job logs above when they are present: they usually name the failure outright. Reproduce locally where they are absent or inconclusive (run the linter/build/test suite the failing check corresponds to), fix the causes minimally, and re-run to verify.
- Respect the PR's intent — repair it, don't rewrite it.
- Leave the finished changes uncommitted and do not push — Companion creates the reviewed commit and publishes it only after approval.
- Finish with a short summary: cause of each failure, what you changed, and how you verified it${SCOPE_AND_ESCALATION}`;
}

function reviewFixObjective(pr: PrRecord, feedback: readonly string[], comments: readonly string[]): string {
  return `You are an autonomous software engineer working in a git worktree checked out AT the head of pull request #${pr.number} ("${pr.title}", branch ${pr.headRef}). Human reviewers asked for changes; implement them.

## Review feedback
${feedback.join('\n\n') || '(none beyond the inline comments)'}

## Inline comments (file:line)
${comments.join('\n') || '(none)'}

${prDiffInspectionGuide(pr.baseRef)}

## Rules
- Work ONLY inside this worktree, on this branch.
- Address every piece of feedback; where a comment is ambiguous, pick the reading most consistent with the codebase and note the choice in your summary.
- Verify your changes (run relevant tests/builds where possible).
- Leave the finished changes uncommitted and do not push — Companion creates the reviewed commit and publishes it only after approval.
- Finish with a summary mapping each review comment to what you did about it${SCOPE_AND_ESCALATION}`;
}

function conflictObjective(pr: PrRecord): string {
  return `You are an autonomous software engineer working in a git worktree checked out AT the head of pull request #${pr.number} ("${pr.title}", branch ${pr.headRef}). The PR has merge conflicts against its target branch ${pr.baseRef}; your job is to resolve them so the PR merges cleanly, without changing what it intends to do.

${prDiffInspectionGuide(pr.baseRef)}

## Rules
- Work ONLY inside this worktree, on this branch. All origin refs were fetched just now — do NOT fetch or pull.
- Run \`git merge origin/${pr.baseRef}\` and resolve every conflict by hand, preserving the intent of BOTH sides: keep what ${pr.baseRef} changed AND what this PR changes. Never resolve by wholesale taking one side.
- After resolving, stage the resolved files and verify the result compiles/passes (run the build or test suite where practical), but leave the merge uncommitted and do not push — Companion completes it only after approval.
- Finish with a short summary: which files conflicted, how you resolved each, and how you verified the result${SCOPE_AND_ESCALATION}`;
}

function customObjective(pr: PrRecord, instructions: string): string {
  return `You are an autonomous software engineer working in a git worktree checked out AT the head of pull request #${pr.number} ("${pr.title}", branch ${pr.headRef}, targeting ${pr.baseRef}). The maintainer asked you to do the following on this PR's branch.

## Task
${instructions.trim()}

${prDiffInspectionGuide(pr.baseRef)}

## Rules
- Work ONLY inside this worktree, on this branch.
- Respect the PR's intent unless the task explicitly says otherwise.
- Verify your changes (run relevant tests/builds where possible).
- Leave the finished changes uncommitted and do not push — Companion creates the reviewed commit and publishes it only after approval.
- Finish with a short summary of what you did and how you verified it.${SCOPE_AND_ESCALATION}`;
}

function prDiffInspectionGuide(baseRef: string): string {
  return `## Inspecting the complete PR
The worktree is at the exact PR head and \`origin/${baseRef}\` was refreshed. Inspect the complete existing change locally; no prompt-sized diff was provided.

- Start with \`git diff --stat origin/${baseRef}...HEAD\`, \`git diff --numstat origin/${baseRef}...HEAD\`, and \`git diff --name-only origin/${baseRef}...HEAD\`.
- Inspect relevant files in bounded groups with \`git diff origin/${baseRef}...HEAD -- <path>...\`; do not dump an oversized whole-PR diff into one tool call.
- If collaboration/subagent tools are available, delegate read-only investigation of disjoint file groups and synthesize the evidence before editing. Do not assume delegation exists.`;
}

function fixObjective(title: string, body: string, issueNumber: number, baseBranch: string): string {
  return `You are an autonomous software engineer working in a dedicated git worktree (branch off origin/${baseBranch}). Fix the following GitHub issue.

## Issue #${issueNumber}: ${title}

${body || '(no description)'}

## Rules
- Work ONLY inside this worktree.
- Investigate the codebase, implement a minimal correct fix, and verify it (run existing tests or a quick check where possible).
- Leave the finished changes uncommitted and do not push — Companion creates the reviewed commit and publishes it only after approval.
- When the fix is complete and verified, finish with a short summary of what you changed and how you verified it.${SCOPE_AND_ESCALATION}`;
}

/** The number out of a pull request's html_url, or null when it does not parse. */
function prNumberFromUrl(url: string): number | null {
  const match = /\/pull\/([0-9]+)(?:$|[/?#])/.exec(url);
  return match ? Number(match[1]) : null;
}
