import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SpaServerMessage } from '@moxxy/companion-contracts';
import type { IssueRecord, TriageResult, TriageVerdict } from '../contract/index.js';
import { log } from '@moxxy/companion-sdk/server';
import { extractModelJson } from '@moxxy/companion-sdk/agents';
import type { CodeStore } from './code-store.js';
import type { OutcomeCounts } from './quality.js';
import type { Orchestrator, Checkouts } from './operate-types.js';
import type { GitHubClient } from './github-client.js';

const verdictSchema = z.object({
  summary: z.string(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'trivial']),
  kind: z.enum(['bug', 'feature', 'question', 'docs', 'chore', 'invalid']),
  labels: z.array(z.string()).max(8),
  duplicateOf: z.number().int().nullable(),
  needsInfo: z.boolean(),
  draftReply: z.string(),
});

/**
 * Review-then-apply triage: an agent reads the issue against the repo checkout
 * and returns a structured verdict; NOTHING touches GitHub until a human
 * clicks Apply.
 */
export class Triage {
  constructor(
    private readonly store: CodeStore,
    private readonly orchestrator: Orchestrator,
    private readonly checkouts: Checkouts,
    private readonly github: (ctx?: { repo?: string; accountId?: string; username?: string | null }) => GitHubClient | null,
    private readonly broadcast: (msg: SpaServerMessage) => void,
  ) {}

  /** Outcome counts for the quality report; the store owns the aggregate. */
  outcomes(workspaceId: string, since: number): OutcomeCounts {
    return this.store.triage.outcomes(workspaceId, since);
  }

  /** Queue a triage run for one issue. Resolves when the verdict is stored. */
  async triageIssue(repo: string, issueNumber: number, userId: string): Promise<TriageResult> {
    const issue = this.store.issues.get(repo, issueNumber);
    if (!issue) throw new Error(`unknown issue ${repo}#${issueNumber}`);
    if (!this.checkouts.hasClone(repo)) throw new Error(`repo ${repo} has no clone yet`);

    const openIssues = this.store.issues
      .list(repo, 'open')
      .filter((i) => i.number !== issueNumber)
      .slice(0, 60);

    const triageId = `triage-${randomUUID().slice(0, 12)}`;
    const { runId, finalMessage } = await this.orchestrator.runOneShot({
      kind: 'triage',
      task: 'code.triage',
      title: `Triage #${issueNumber}: ${issue.title.slice(0, 60)}`,
      cwd: this.checkouts.cloneDir(repo),
      repo,
      userId,
      issueNumber,
      prompt: buildTriagePrompt(issue, openIssues),
      timeoutMs: 6 * 60_000,
      resume: { type: 'triage', args: { repo, number: issueNumber, userId } },
    });

    let verdict: TriageVerdict | null = null;
    let error: string | null = null;
    try {
      verdict = parseVerdict(finalMessage ?? '');
    } catch (err) {
      error = `could not parse triage verdict: ${String(err)}`;
      log.warn('triage parse failed', { repo, issueNumber, err: String(err) });
    }

    const result: TriageResult = {
      id: triageId,
      repo,
      issueNumber,
      runId,
      status: verdict ? 'pending' : 'failed',
      verdict,
      error,
      createdAt: Date.now(),
    };
    this.store.triage.insert(result);
    this.broadcast({ t: 'triage.changed', repo });
    this.broadcast({ t: 'issues.changed', repo });
    return result;
  }

  /** Apply a pending verdict to GitHub: labels + (optional) draft reply comment. */
  async apply(
    id: string,
    opts: { comment: boolean; accountId?: string; userId: string },
  ): Promise<{ repo: string; number: number }> {
    const result = this.findTriage(id);
    if (!result || !result.verdict) throw new Error('triage result not found or has no verdict');
    if (result.status !== 'pending') throw new Error(`triage is ${result.status}, not pending`);
    const client = this.github({ repo: result.repo, accountId: opts.accountId, username: opts.userId });
    if (!client) throw new Error('GitHub is not configured');

    const labels = [...result.verdict.labels];
    if (result.verdict.duplicateOf) labels.push('duplicate');
    if (result.verdict.needsInfo) labels.push('needs-info');
    if (labels.length > 0) await client.addLabels(result.repo, result.issueNumber, dedupe(labels));

    let reply = result.verdict.draftReply.trim();
    if (result.verdict.duplicateOf) {
      reply = reply || `This looks like a duplicate of #${result.verdict.duplicateOf}.`;
    }
    if (opts.comment && reply) {
      await client.comment(result.repo, result.issueNumber, reply);
    }

    this.store.triage.update(id, 'applied');
    this.broadcast({ t: 'triage.changed', repo: result.repo });
    return { repo: result.repo, number: result.issueNumber };
  }

  dismiss(id: string): void {
    const result = this.findTriage(id);
    if (!result) throw new Error('triage result not found');
    this.store.triage.update(id, 'dismissed');
    this.broadcast({ t: 'triage.changed', repo: result.repo });
  }

  private findTriage(id: string): TriageResult | undefined {
    for (const repo of this.store.repos.list()) {
      const hit = this.store.triage.list(repo.full_name).find((t) => t.id === id);
      if (hit) return hit;
    }
    return undefined;
  }
}

function buildTriagePrompt(issue: IssueRecord, openIssues: IssueRecord[]): string {
  const others = openIssues
    .map((i) => `- #${i.number}: ${i.title}${i.labels.length ? ` [${i.labels.join(', ')}]` : ''}`)
    .join('\n');
  return `You are triaging a GitHub issue for the repository checked out in the current directory.

READ-ONLY RULES (mandatory): you may read files and search the codebase to assess the issue, but you must NOT modify, create, or delete any file, and you must NOT run any command that writes (no git commit/push, no installs). Your ONLY output is the final JSON verdict.

## Issue #${issue.number}: ${issue.title}
Author: ${issue.author} | State: ${issue.state} | Existing labels: ${issue.labels.join(', ') || '(none)'}

${issue.body || '(no description)'}

## Other open issues (for duplicate detection)
${others || '(none)'}

## Your task
Investigate briefly (read relevant code if useful), then reply with ONLY a JSON object (no markdown fence, no prose before or after) matching exactly this shape:
{
  "summary": "<1-2 sentence assessment of what this issue is and whether it is valid>",
  "severity": "critical" | "high" | "medium" | "low" | "trivial",
  "kind": "bug" | "feature" | "question" | "docs" | "chore" | "invalid",
  "labels": ["<up to 5 suggested labels, lowercase-kebab>"],
  "duplicateOf": <issue number if this duplicates one of the other open issues, else null>,
  "needsInfo": <true if the report is missing information needed to act>,
  "draftReply": "<a short, friendly reply to post on the issue; empty string if none needed>"
}`;
}

export function parseVerdict(text: string): TriageVerdict {
  return verdictSchema.parse(extractModelJson(text)) as TriageVerdict;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}
