import type { RunRecord, SpaServerMessage } from '@companion/contract';
import type { Store } from '../store/db.js';
import type { Orchestrator } from './orchestrator.js';
import type { Checkouts } from '../git/checkouts.js';
import type { GitHubClient } from '../github/client.js';

/**
 * Fix-issue-to-PR: a goal-mode agent works in a dedicated worktree; the human
 * reviews the diff; companiond (never the agent) pushes and opens the PR.
 */
export class Fixes {
  constructor(
    private readonly store: Store,
    private readonly orchestrator: Orchestrator,
    private readonly checkouts: Checkouts,
    private readonly github: () => GitHubClient | null,
    private readonly broadcast: (msg: SpaServerMessage) => void,
  ) {}

  async startFix(repo: string, issueNumber: number): Promise<RunRecord> {
    const issue = this.store.issues.get(repo, issueNumber);
    if (!issue) throw new Error(`unknown issue ${repo}#${issueNumber}`);
    const repoRow = this.store.repos.get(repo);
    if (!repoRow) throw new Error(`unknown repo ${repo}`);
    if (!this.checkouts.hasClone(repo)) throw new Error(`repo ${repo} has no clone yet`);

    // Create the run row first so the worktree can be named after it.
    const run = await this.createGoalRun({
      kind: 'fix',
      title: `Fix #${issueNumber}: ${issue.title.slice(0, 60)}`,
      repo,
      issueNumber,
      branchPrefix: `companion/issue-${issueNumber}`,
      baseBranch: repoRow.default_branch,
      objective: fixObjective(issue.title, issue.body, issueNumber, repoRow.default_branch),
    });
    return run;
  }

  /**
   * Shared goal-run bootstrap for fixes and proposal implementations:
   * worktree + branch → run with cwd=worktree → goal mode → objective prompt.
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
  }): Promise<RunRecord> {
    const suffix = Date.now().toString(36).slice(-4);
    const branch = `${opts.branchPrefix}-${suffix}`;

    const run = await this.orchestrator.createRun({
      kind: opts.kind,
      title: opts.title,
      // Temporary cwd; replaced by the worktree before the gateway spawns? No —
      // the worktree must exist first, so we create it named after a fresh id.
      cwd: await this.checkouts.addWorktree(opts.repo, `${opts.kind}-${suffix}-${Math.random().toString(36).slice(2, 8)}`, branch, opts.baseBranch),
      repo: opts.repo,
      issueNumber: opts.issueNumber ?? null,
      proposalId: opts.proposalId ?? null,
      branch,
    });

    await this.orchestrator.setGoalMode(run.id);
    await this.orchestrator.sendPrompt(run.id, opts.objective);
    return this.orchestrator.getRun(run.id)!;
  }

  async diff(runId: string): Promise<{ diff: string; branch: string | null }> {
    const run = this.store.runs.get(runId);
    if (!run || !run.repo) throw new Error('run not found or not a repo run');
    const repoRow = this.store.repos.get(run.repo);
    const diff = await this.checkouts.diffVsBase(run.cwd, repoRow?.default_branch ?? 'main');
    return { diff, branch: run.branch };
  }

  /** Human approved the diff: commit leftovers, push, open the PR. */
  async approve(runId: string, opts: { title?: string; body?: string } = {}): Promise<{ prUrl: string }> {
    const run = this.store.runs.get(runId);
    if (!run || !run.repo || !run.branch) throw new Error('run not found or has no branch');
    const repoRow = this.store.repos.get(run.repo);
    if (!repoRow) throw new Error(`unknown repo ${run.repo}`);
    const client = this.github();
    if (!client) throw new Error('GitHub is not configured');

    await this.checkouts.commitAll(run.cwd, opts.title ?? run.title);
    await this.checkouts.push(run.repo, run.cwd, run.branch);
    const pr = await client.createPr(run.repo, {
      title: opts.title ?? run.title,
      head: run.branch,
      base: repoRow.default_branch,
      body:
        opts.body ??
        `${run.outcome ?? ''}\n\n${run.issue_number ? `Closes #${run.issue_number}.` : ''}`.trim(),
    });

    this.store.runs.setPr(runId, run.branch, pr.html_url);
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
      await this.checkouts.removeWorktree(run.repo, run.cwd);
    }
    this.orchestrator.markRun(runId, 'abandoned', 'discarded by user');
  }
}

function fixObjective(title: string, body: string, issueNumber: number, baseBranch: string): string {
  return `You are an autonomous software engineer working in a dedicated git worktree (branch off origin/${baseBranch}). Fix the following GitHub issue.

## Issue #${issueNumber}: ${title}

${body || '(no description)'}

## Rules
- Work ONLY inside this worktree.
- Investigate the codebase, implement a minimal correct fix, and verify it (run existing tests or a quick check where possible).
- Commit your work with clear messages (git add + git commit). Do NOT push — the maintainer reviews the diff and pushes after approval.
- When the fix is complete and verified, finish with a short summary of what you changed and how you verified it.`;
}
