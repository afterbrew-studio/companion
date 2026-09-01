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
 * Oldest-first commits. HEAD is the last entry. Unrecoverable when an ancestor
 * (not HEAD) would fail the ownership gate on its own file list.
 */
export function unrecoverableOwnedAncestor(
  commits: readonly RangeCommit[],
  rules: readonly OwnershipRule[],
): RangeCommit | null {
  if (commits.length < 2 || rules.length === 0) return null;
  const ancestors = commits.slice(0, -1);
  return ancestors.find((commit) => commitViolatesOwnership(commit, rules)) ?? null;
}
