/**
 * Per-commit ownership cannot be repaired by a follow-up commit: the ancestor
 * stays in BASE..HEAD. Revert does not help when that commit still owns a
 * required path. The lane abandons the branch and opens a successor from the
 * current tree on a clean base instead of looping fix_ci.
 */

export interface RangeCommit {
  readonly sha: string;
  readonly message: string;
}

const DEFAULT_OWNED = [
  'docs/',
  'agents/',
  'AGENTS.md',
  'ARCHITECTURE.md',
  'CLAUDE.md',
  '.agents/',
  '.claude/',
  '.codex/',
];

const OWNERSHIP_TRAILER = /doc-ownership\s*\(/i;

export function pathIsOwned(path: string, prefixes: readonly string[] = DEFAULT_OWNED): boolean {
  const normalised = path.replace(/^\.\//, '');
  return prefixes.some((prefix) =>
    prefix.endsWith('/') ? normalised.startsWith(prefix) : normalised === prefix,
  );
}

export function prTouchesOwnedPaths(
  files: readonly string[],
  prefixes: readonly string[] = DEFAULT_OWNED,
): boolean {
  return files.some((file) => pathIsOwned(file, prefixes));
}

/**
 * Oldest-first commits. HEAD is the last entry. Unrecoverable when an ancestor
 * (not HEAD) lacks the ownership trailer and the pull request as a whole
 * touches an owned path — a later commit cannot rewrite that ancestor.
 */
export function unrecoverableOwnedAncestor(
  commits: readonly RangeCommit[],
  ownedFiles: readonly string[],
  prefixes: readonly string[] = DEFAULT_OWNED,
): RangeCommit | null {
  if (commits.length < 2) return null;
  if (!prTouchesOwnedPaths(ownedFiles, prefixes)) return null;
  const ancestors = commits.slice(0, -1);
  return ancestors.find((commit) => !OWNERSHIP_TRAILER.test(commit.message)) ?? null;
}
