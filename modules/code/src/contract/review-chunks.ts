import type { FileChangeSize } from './diff-anchors.js';

/**
 * Splitting a large pull request into reviewable pieces.
 *
 * Each review pass receives a server-built, size-bounded diff and may inspect a
 * disposable checkout for surrounding code. Context is still finite: past a
 * few hundred changed lines the earliest evidence can fall out while a verdict
 * still arrives. Splitting therefore protects reasoning quality as well as the
 * transport budget; a larger timeout would not make an overfilled context safe.
 *
 * Pure and separate so the split can be reasoned about without a repository.
 */

/** Changed lines one pass is expected to hold and still reason about. */
export const CHUNK_BUDGET_LINES = 1200;

/**
 * Above this a pull request is not reviewable in depth at any chunk count: the
 * summary alone would be guesswork, and spending an hour to say so is worse
 * than saying it up front.
 */
export const MAX_CHUNKS = 12;

export interface ReviewChunk {
  readonly paths: readonly string[];
  readonly changed: number;
}

/**
 * Group changed files into passes of roughly `budget` changed lines.
 *
 * Sorted by path first, so a chunk tends to hold neighbouring files: reviewing
 * `src/api/*` together gives each file the others as context, while an
 * alphabetical accident of `api/x` beside `web/z` gives neither. A file larger
 * than the budget gets a pass to itself rather than being split, because half a
 * file reviewed out of context is where false findings come from.
 */
export function planReviewChunks(
  files: readonly FileChangeSize[],
  budget: number = CHUNK_BUDGET_LINES,
): ReviewChunk[] {
  const ordered = [...files].filter((f) => f.changed > 0).sort((a, b) => a.path.localeCompare(b.path));
  const chunks: ReviewChunk[] = [];
  let paths: string[] = [];
  let changed = 0;

  const flush = (): void => {
    if (paths.length > 0) chunks.push({ paths, changed });
    paths = [];
    changed = 0;
  };

  for (const file of ordered) {
    // Starting a fresh pass for an oversized file keeps it away from the small
    // ones, which would otherwise be reviewed in whatever context it left.
    if (file.changed >= budget) {
      flush();
      chunks.push({ paths: [file.path], changed: file.changed });
      continue;
    }
    if (changed + file.changed > budget) flush();
    paths.push(file.path);
    changed += file.changed;
  }
  flush();
  return chunks;
}

export type ReviewPlan =
  /** Small enough for one pass; today's behaviour. */
  | { readonly kind: 'single' }
  /** Reviewed in pieces, then summarised from the findings. */
  | { readonly kind: 'chunked'; readonly chunks: readonly ReviewChunk[] }
  /** Too large to review in depth honestly. */
  | { readonly kind: 'too-large'; readonly chunks: number; readonly changed: number };

/**
 * What to do with this pull request.
 *
 * The refusal is deliberate and belongs before the work, not after it: a review
 * that runs for an hour and then reports a verdict about a third of the diff is
 * worse than one that says at the start that it cannot be done in depth.
 */
export function planReview(
  files: readonly FileChangeSize[],
  opts: { budget?: number; maxChunks?: number } = {},
): ReviewPlan {
  const budget = opts.budget ?? CHUNK_BUDGET_LINES;
  const maxChunks = opts.maxChunks ?? MAX_CHUNKS;
  const chunks = planReviewChunks(files, budget);
  // A single giant file used to produce exactly one chunk and therefore fall
  // through as a safe single pass. It is the worst context-overflow case: the
  // path cannot be split without hunk-aware planning, so refuse honestly.
  if (chunks.some((chunk) => chunk.changed > budget)) {
    return { kind: 'too-large', chunks: chunks.length, changed: chunks.reduce((n, c) => n + c.changed, 0) };
  }
  if (chunks.length <= 1) return { kind: 'single' };
  if (chunks.length > maxChunks) {
    return { kind: 'too-large', chunks: chunks.length, changed: chunks.reduce((n, c) => n + c.changed, 0) };
  }
  return { kind: 'chunked', chunks };
}
