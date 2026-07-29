import type { ModuleConfigAccessor } from '@moxxy/companion-core';
import type { AgentPolicySnapshot } from '../contract/index.js';

/**
 * Raised when a policy refuses an agent action. 403, because unlike a budget
 * refusal this will not clear on its own: someone has to change the policy.
 */
export class AgentPolicyError extends Error {
  readonly status = 403;
  constructor(message: string) {
    super(message);
    this.name = 'AgentPolicyError';
  }
}

/** Default ceiling, kept as the value the constant had before it was configurable. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 400_000;

/** Branch names agents may not push to unless an operator says otherwise. */
export const DEFAULT_PROTECTED_BRANCHES = 'main, master, release/*, prod';

/**
 * Match a branch against one pattern. `*` is the only metacharacter, matching
 * within a path segment and across separators alike, because `release/*` has to
 * cover `release/2026-07` and nobody writing this expects glob subtleties.
 */
export function branchMatches(pattern: string, branch: string): boolean {
  const escaped = pattern
    .trim()
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  if (!escaped) return false;
  return new RegExp(`^${escaped}$`, 'i').test(branch);
}

export function parsePatterns(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(/[,\n]/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * What agent work is permitted to do, as instance configuration rather than as
 * constants spread through the execution plane.
 *
 * The four fences that keep an unattended run safe (an isolated worktree, moxxy
 * deny rules, the output-token ceiling, and review-then-apply for anything that
 * reaches GitHub) were all decided in code. Two of them are genuinely structural
 * and stay that way; the two an organisation actually asks about are here, where
 * they can be read, changed and audited:
 *
 * - may agent work write to a repository at all, and
 * - which branches it may never push to.
 *
 * Enforced at the credential seam rather than at each feature. Every network git
 * operation on every runner, local or remote, resolves its credential through
 * the daemon, so a refusal here cannot be routed around by a new caller.
 */
export class AgentPolicy {
  constructor(
    private readonly moduleConfig: ModuleConfigAccessor,
    /** Records a refusal for the audit trail; the router covers routes, not this. */
    private readonly audit: (action: string, detail: string) => void = () => {},
  ) {}

  /** False when agents are read-only on every repository. */
  gitWriteAllowed(): boolean {
    return this.moduleConfig.get('agentGitWrite') !== 'refused';
  }

  protectedBranches(): string[] {
    const raw = this.moduleConfig.get('protectedBranches');
    // An unset value is the default set, but an explicitly emptied one means
    // "protect nothing": a policy field must be able to say no as well as yes.
    return parsePatterns(raw === null || raw === undefined ? DEFAULT_PROTECTED_BRANCHES : raw);
  }

  maxOutputTokens(): number {
    const value = this.moduleConfig.get('maxRunOutputTokens');
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_OUTPUT_TOKENS;
  }

  /**
   * Gate on write access to a repository. Called from the credential resolver, so
   * it covers clones, worktrees and pushes on every runner.
   */
  assertGitWrite(repo: string | null): void {
    if (this.gitWriteAllowed()) return;
    const detail = `agent git write refused for ${repo ?? 'a scratch run'}: policy is read-only`;
    this.audit('policy.git-write.refused', detail);
    throw new AgentPolicyError(
      'this instance does not allow agents to write to repositories. An administrator can change ' +
        '"Agent repository access" under Modules to re-enable it.',
    );
  }

  /** Gate on the branch a push targets. Called where the branch is known. */
  assertPushTarget(repo: string, branch: string): void {
    this.assertGitWrite(repo);
    const hit = this.protectedBranches().find((pattern) => branchMatches(pattern, branch));
    if (hit === undefined) return;
    const detail = `agent push to ${repo}#${branch} refused: matches protected pattern '${hit}'`;
    this.audit('policy.push.refused', detail);
    throw new AgentPolicyError(
      `'${branch}' is a protected branch on this instance (matched '${hit}'), so agent work may not push to it. ` +
        'Agents open pull requests from their own branches instead.',
    );
  }

  /** The effective policy, for the settings surface and for an auditor. */
  snapshot(): AgentPolicySnapshot {
    return {
      gitWrite: this.gitWriteAllowed() ? 'allowed' : 'refused',
      protectedBranches: this.protectedBranches(),
      maxOutputTokens: this.maxOutputTokens(),
    };
  }
}
