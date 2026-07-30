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

/**
 * What this instance may write back to the forge.
 *
 * `attended` is the setting most people actually want and the reason this is not
 * a boolean: let the agents analyse, triage and screen continuously, but never let
 * anything appear under the instance's GitHub identity without a person having
 * asked for it in that moment. A public repository is the sharp case, where an
 * unprompted machine comment on a stranger's first contribution is a
 * reputational act.
 */
export type GitHubWritePolicy = 'allowed' | 'attended' | 'refused';

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

  gitHubWrite(): GitHubWritePolicy {
    const value = this.moduleConfig.get('agentGitHubWrite');
    return value === 'attended' || value === 'refused' ? value : 'allowed';
  }

  /**
   * Gate a write to the forge's API: a comment, a label, a review, a merge.
   *
   * `attended` means a human is on the other end of the request making it happen
   * right now. That is read from the request-scoped invoker the account resolver
   * already uses to decide which credential to act as, so attendance has ONE
   * definition in this codebase rather than two that drift. Work outside a
   * request (a webhook, a schedule, a queued run) sees no user and is unattended
   * by construction.
   */
  assertGitHubWrite(attended: boolean, what: string): void {
    const policy = this.gitHubWrite();
    if (policy === 'allowed') return;
    if (policy === 'attended' && attended) return;
    const detail = `GitHub write refused (${what}): policy is '${policy}'${attended ? '' : ', and nobody is asking for it'}`;
    this.audit('policy.github-write.refused', detail);
    throw new AgentPolicyError(
      policy === 'refused'
        ? 'this instance does not write to GitHub. Verdicts are still produced and stored; an administrator can ' +
          'change "Writing to GitHub" under Modules.'
        : 'this instance only writes to GitHub when a person asks for it, and this write came from automation. ' +
          'Apply the verdict yourself, or change "Writing to GitHub" under Modules.',
    );
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
      gitHubWrite: this.gitHubWrite(),
      protectedBranches: this.protectedBranches(),
      maxOutputTokens: this.maxOutputTokens(),
    };
  }
}
