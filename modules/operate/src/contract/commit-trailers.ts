/**
 * A repository may refuse a commit that does not explain itself: rayf will not
 * accept a change to a document it maps to code, or to the body of an accepted
 * decision record, without a trailer naming the document and why. The daemon
 * writes the commit, not the agent, so the lane could not satisfy those gates
 * at all - the work was correct and the commit was rejected forever, one repair
 * cycle after another.
 *
 * The agent leaves them in this file and the daemon appends them. Read and
 * deleted before anything is staged, so the file never lands in the tree.
 */
export const COMMIT_TRAILERS_FILE = '.companion-commit-trailers';

/**
 * One bullet, appended to every objective whose work ends in a Companion-made
 * commit. Only the build stage carried it, so a repair run that tripped a
 * trailer-demanding gate had no legal move: the scope contract forbids editing
 * the check, and nothing told it this file existed. It spent the repair ceiling
 * and the card failed with the change correct and unmergeable.
 */
export const COMMIT_TRAILER_RULE = `- If a check demands a commit trailer to accept your change - a waiver naming a
  document, an amendment naming a record - write one per line into
  \`${COMMIT_TRAILERS_FILE}\` at the root of this worktree, in the exact form
  the check asks for (\`token: value\` or \`token(scope): value\`). Companion
  appends them to the commit it makes and the file is never committed. This is
  the only way your change can carry one, so a check that asks for a trailer is
  satisfied here rather than worked around: do not edit the check, and do not
  revert the change that triggered it.`;
