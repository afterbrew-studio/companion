/**
 * Per-commit ownership cannot be repaired by a follow-up commit: the ancestor
 * stays in BASE..HEAD. The detector mirrors `check_doc_ownership.py`: a `when`
 * glob without every `update` path and without a `doc-ownership(` trailer.
 * Keying on owning-document paths (the `update` side) is the opposite test.
 */

export interface RangeCommit {
  readonly sha: string;
  readonly message: string;
  readonly files: readonly string[];
}

export interface OwnershipRule {
  readonly when: readonly string[];
  readonly update: readonly string[];
}

const OWNERSHIP_TRAILER = /doc-ownership\s*\(/i;

export function parseOwnershipRules(text: string): OwnershipRule[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { rules?: unknown }).rules)) {
    return [];
  }
  const rules: OwnershipRule[] = [];
  for (const row of (parsed as { rules: unknown[] }).rules) {
    if (!row || typeof row !== 'object') continue;
    const when = (row as { when?: unknown }).when;
    const update = (row as { update?: unknown }).update;
    if (!Array.isArray(when) || !Array.isArray(update)) continue;
    const whenPaths = when.filter((item): item is string => typeof item === 'string' && item !== '');
    const updatePaths = update.filter((item): item is string => typeof item === 'string' && item !== '');
    if (whenPaths.length === 0 || updatePaths.length === 0) continue;
    rules.push({ when: whenPaths, update: updatePaths });
  }
  return rules;
}

export function pathMatches(path: string, pattern: string): boolean {
  const normalised = path.replace(/^\.\//, '');
  const glob = pattern.replace(/^\.\//, '');
  if (glob.endsWith('/**')) {
    const prefix = glob.slice(0, -3);
    return normalised === prefix || normalised.startsWith(`${prefix}/`);
  }
  if (glob.includes('*')) {
    const escaped = glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '::GLOBSTAR::')
      .replace(/\*/g, '[^/]*')
      .replace(/::GLOBSTAR::/g, '.*');
    return new RegExp(`^${escaped}$`).test(normalised);
  }
  return normalised === glob;
}

export function commitViolatesOwnership(
  commit: RangeCommit,
  rules: readonly OwnershipRule[],
): boolean {
  if (OWNERSHIP_TRAILER.test(commit.message)) return false;
  for (const rule of rules) {
    const whenHit = commit.files.some((file) => rule.when.some((pattern) => pathMatches(file, pattern)));
    if (!whenHit) continue;
    const updated = rule.update.every((required) =>
      commit.files.some((file) => pathMatches(file, required) || file === required),
    );
    if (!updated) return true;
  }
  return false;
}

/**
 * What an ownership read concluded, as three distinguishable answers rather
 * than one nullable one.
 *
 * `unreadable` is the case that matters. A commit whose file list came back
 * empty matches no `when` glob, so it reads as innocent and the whole history
 * reads as clean - the pull request stays unrepairable and nothing says why.
 * An empty result is a failed read, not a clean commit.
 *
 * `no-ancestor` covers a range too short to be stuck on, which is any pull
 * request with fewer than two commits.
 */
export type OwnedHistoryVerdict =
  | { readonly kind: 'unrecoverable'; readonly commit: RangeCommit }
  | { readonly kind: 'clean' }
  | { readonly kind: 'unreadable'; readonly sha: string }
  | { readonly kind: 'no-ancestor' };

export function judgeOwnedHistory(
  commits: readonly RangeCommit[],
  rules: readonly OwnershipRule[],
): OwnedHistoryVerdict {
  if (commits.length < 2 || rules.length === 0) return { kind: 'no-ancestor' };
  const unreadable = commits.find((commit) => commit.files.length === 0);
  if (unreadable) return { kind: 'unreadable', sha: unreadable.sha };
  const commit = unrecoverableOwnedCommit(commits, rules);
  return commit ? { kind: 'unrecoverable', commit } : { kind: 'clean' };
}

/**
 * Oldest-first commits. Unrecoverable when ANY of them would fail the ownership
 * gate on its own file list, HEAD included.
 *
 * HEAD used to be excluded, on the reading that the tip is still repairable.
 * It is not: the gate reads every commit in BASE..HEAD, and a commit is only
 * ever added, never amended. A violating tip is as permanent as a violating
 * ancestor, and it is the common case - the offender is usually the repair
 * commit that just landed, so it is the tip at exactly the moment the next
 * failing check asks this question. rayf #599 declined here with "every
 * ancestor satisfies the ownership map" while its tip was the violation.
 *
 * Two commits are still required. A one-commit pull request that violates is
 * the successor this function's caller would open, so reopening it would spin.
 */
export function unrecoverableOwnedCommit(
  commits: readonly RangeCommit[],
  rules: readonly OwnershipRule[],
): RangeCommit | null {
  if (commits.length < 2 || rules.length === 0) return null;
  return commits.find((commit) => commitViolatesOwnership(commit, rules)) ?? null;
}
