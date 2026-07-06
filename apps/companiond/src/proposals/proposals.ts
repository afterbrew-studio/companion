import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ProposalAnalysis, ProposalRecord, SpaServerMessage } from '@companion/contract';
import { log } from '../log.js';
import type { Store } from '../store/db.js';
import type { Orchestrator } from '../runs/orchestrator.js';
import type { Fixes } from '../runs/fixes.js';
import type { Checkouts } from '../git/checkouts.js';
import { extractModelJson } from '../lib/model-json.js';

const analysisSchema = z.object({
  summary: z.string(),
  feasibility: z.enum(['low', 'medium', 'high']),
  steps: z.array(z.string()).min(1).max(12),
  touchedAreas: z.array(z.string()).max(12),
  risks: z.array(z.string()).max(12),
});

/**
 * Proposals: maintainer writes an idea → a read-only analysis agent produces a
 * structured plan → maintainer approves → a goal-mode agent implements it in a
 * worktree → diff review → PR (via the shared Fixes machinery).
 */
export class Proposals {
  constructor(
    private readonly store: Store,
    private readonly orchestrator: Orchestrator,
    private readonly fixes: Fixes,
    private readonly checkouts: Checkouts,
    private readonly broadcast: (msg: SpaServerMessage) => void,
  ) {}

  create(repo: string, title: string, body: string): ProposalRecord {
    const proposal: ProposalRecord = {
      id: `prop-${randomUUID().slice(0, 12)}`,
      repo,
      title,
      body,
      status: 'draft',
      analysis: null,
      analysisRunId: null,
      implementRunId: null,
      branch: null,
      prUrl: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.store.insertProposal(proposal);
    this.broadcast({ t: 'proposals.changed' });
    return proposal;
  }

  /** Kick the analysis run (async — resolves when analysis is stored). */
  async analyze(id: string): Promise<ProposalRecord> {
    const proposal = this.store.getProposal(id);
    if (!proposal) throw new Error('proposal not found');
    if (!this.checkouts.hasClone(proposal.repo)) throw new Error(`repo ${proposal.repo} has no clone yet`);

    this.store.updateProposal(id, { status: 'analyzing' });
    this.broadcast({ t: 'proposals.changed' });

    try {
      const { runId, finalMessage } = await this.orchestrator.runOneShot({
        kind: 'analysis',
        title: `Analyze proposal: ${proposal.title.slice(0, 60)}`,
        cwd: this.checkouts.cloneDir(proposal.repo),
        repo: proposal.repo,
        prompt: analysisPrompt(proposal),
        timeoutMs: 10 * 60_000,
      });
      const analysis = parseAnalysis(finalMessage ?? '');
      this.store.updateProposal(id, { status: 'analyzed', analysis, analysisRunId: runId });
    } catch (err) {
      log.warn('proposal analysis failed', { id, err: String(err) });
      this.store.updateProposal(id, { status: 'failed' });
      this.broadcast({ t: 'proposals.changed' });
      throw err;
    }
    this.broadcast({ t: 'proposals.changed' });
    return this.store.getProposal(id)!;
  }

  /** Maintainer approved the analyzed plan → start the implementation goal run. */
  async approve(id: string): Promise<ProposalRecord> {
    const proposal = this.store.getProposal(id);
    if (!proposal) throw new Error('proposal not found');
    if (proposal.status !== 'analyzed') throw new Error(`proposal is ${proposal.status}, not analyzed`);
    const repoRow = this.store.getRepo(proposal.repo);
    if (!repoRow) throw new Error(`unknown repo ${proposal.repo}`);

    this.store.updateProposal(id, { status: 'implementing' });
    this.broadcast({ t: 'proposals.changed' });

    const run = await this.fixes.createGoalRun({
      kind: 'implement',
      title: `Implement: ${proposal.title.slice(0, 60)}`,
      repo: proposal.repo,
      proposalId: id,
      branchPrefix: `companion/proposal-${id.replace('prop-', '')}`,
      baseBranch: repoRow.default_branch,
      objective: implementObjective(proposal),
    });
    this.store.updateProposal(id, { implementRunId: run.id, branch: run.branch ?? undefined });
    this.broadcast({ t: 'proposals.changed' });
    return this.store.getProposal(id)!;
  }

  /** Implementation diff approved → push + PR, mark implemented. */
  async finishImplementation(id: string): Promise<ProposalRecord> {
    const proposal = this.store.getProposal(id);
    if (!proposal?.implementRunId) throw new Error('proposal has no implementation run');
    const { prUrl } = await this.fixes.approve(proposal.implementRunId, {
      title: proposal.title,
      body: `${proposal.body}\n\n---\n${proposal.analysis?.summary ?? ''}`,
    });
    this.store.updateProposal(id, { status: 'implemented', prUrl });
    this.broadcast({ t: 'proposals.changed' });
    return this.store.getProposal(id)!;
  }

  reject(id: string): void {
    this.store.updateProposal(id, { status: 'rejected' });
    this.broadcast({ t: 'proposals.changed' });
  }

  /** Called when an implement run lands in review — flip the proposal too. */
  onRunReview(runId: string): void {
    for (const proposal of this.store.listProposals()) {
      if (proposal.implementRunId === runId && proposal.status === 'implementing') {
        this.store.updateProposal(proposal.id, { status: 'review' });
        this.broadcast({ t: 'proposals.changed' });
      }
    }
  }
}

function analysisPrompt(proposal: ProposalRecord): string {
  return `You are analyzing a change proposal for the repository checked out in the current directory.

READ-ONLY RULES (mandatory): you may read files and search the codebase, but you must NOT modify anything. Your ONLY output is the final JSON.

## Proposal: ${proposal.title}

${proposal.body}

## Your task
Assess feasibility against the actual codebase, then reply with ONLY a JSON object (no fence, no prose) of exactly this shape:
{
  "summary": "<2-3 sentence assessment>",
  "feasibility": "low" | "medium" | "high",
  "steps": ["<ordered implementation steps, each one concrete>"],
  "touchedAreas": ["<files/modules that will change>"],
  "risks": ["<what could go wrong / needs care>"]
}`;
}

function implementObjective(proposal: ProposalRecord): string {
  const steps = proposal.analysis?.steps.map((s, i) => `${i + 1}. ${s}`).join('\n') ?? '';
  return `You are an autonomous software engineer working in a dedicated git worktree. Implement the following approved proposal.

## Proposal: ${proposal.title}

${proposal.body}

## Approved implementation plan
${steps || '(derive a sensible plan from the proposal)'}

## Rules
- Work ONLY inside this worktree.
- Follow the plan step by step; commit after each meaningful step (git add + git commit).
- Verify your work (run tests / build where possible) before finishing.
- Do NOT push — the maintainer reviews the diff and pushes after approval.
- Finish with a short summary of what you changed and how you verified it.`;
}

export function parseAnalysis(text: string): ProposalAnalysis {
  return analysisSchema.parse(extractModelJson(text)) as ProposalAnalysis;
}
