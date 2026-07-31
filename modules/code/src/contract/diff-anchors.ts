/**
 * Anchoring a review finding to a line of a unified diff.
 *
 * Input is a diff STRING, never a pull-request payload: the same index serves a
 * PR (patches from GitHub's files API, reassembled) and a local branch diff
 * (`git diff base...HEAD`), so nothing here may learn what a pull request is.
 *
 * This exists because GitHub rejects a review comment whose line is not part of
 * the diff, and rejects the WHOLE review with it. An agent reading a checkout
 * cites lines it read, which is a superset of the lines it may comment on, so
 * every anchor is validated here before anything is posted.
 */

export type DiffSide = 'LEFT' | 'RIGHT';

/** A line of the diff, addressable the way GitHub addresses it. */
interface IndexedLine {
  readonly text: string;
  /** Position in the rendered diff body, for excerpting around it. */
  readonly at: number;
}

export interface AnchorIndex {
  /** Files the diff touches, in order of appearance. */
  files(): readonly string[];
  has(file: string, side: DiffSide, line: number): boolean;
  lineText(file: string, side: DiffSide, line: number): string | null;
  /** The anchored line with surrounding context, for the finding card. */
  excerpt(file: string, side: DiffSide, line: number, context?: number): string | null;
}

interface FileIndex {
  readonly path: string;
  readonly body: string[];
  readonly left: Map<number, IndexedLine>;
  readonly right: Map<number, IndexedLine>;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Both the `a/` and `b/` paths are recorded for a rename: an agent may cite
 * either, and refusing the one it happened to pick would drop a real finding.
 */
function headerPaths(line: string): { display: string; aliases: string[] } | null {
  const git = line.match(/^diff --git a\/(.+) b\/(.+)$/);
  if (git) {
    const from = git[1]!;
    const to = git[2]!;
    return { display: to, aliases: from === to ? [to] : [to, from] };
  }
  return null;
}

export function buildAnchorIndex(unifiedDiff: string): AnchorIndex {
  const order: string[] = [];
  const byPath = new Map<string, FileIndex>();
  let current: FileIndex | null = null;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  const open = (display: string, aliases: string[]): void => {
    current = { path: display, body: [], left: new Map(), right: new Map() };
    order.push(display);
    for (const alias of aliases) byPath.set(alias, current);
    inHunk = false;
  };

  const lines = unifiedDiff.split('\n');
  // A diff ends with a newline, so the split leaves a trailing empty element.
  // Counting it as a context line invents a line at the end of the last file
  // that validates here and is then rejected by GitHub.
  if (lines[lines.length - 1] === '') lines.pop();

  for (const raw of lines) {
    const header = headerPaths(raw);
    if (header) {
      open(header.display, header.aliases);
      continue;
    }
    if (!current) {
      // A bare patch with no `diff --git` header (a single-file `git diff`
      // piped in, or a run diff): everything belongs to one unnamed file.
      open('', ['']);
    }
    const file = current!;
    const hunk = raw.match(HUNK);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      inHunk = true;
      file.body.push(raw);
      continue;
    }
    if (!inHunk) continue; // index/mode/---/+++ preamble

    const at = file.body.push(raw) - 1;
    if (raw.startsWith('+')) {
      file.right.set(newLine++, { text: raw.slice(1), at });
    } else if (raw.startsWith('-')) {
      file.left.set(oldLine++, { text: raw.slice(1), at });
    } else if (raw.startsWith('\\')) {
      // "\ No newline at end of file" belongs to the line before it and
      // advances neither counter.
    } else {
      // Context. The leading space is absent on an empty context line, which
      // is why this is the fallthrough rather than a `startsWith(' ')` test.
      const text = raw.startsWith(' ') ? raw.slice(1) : raw;
      file.left.set(oldLine++, { text, at });
      file.right.set(newLine++, { text, at });
    }
  }

  const lookup = (file: string, side: DiffSide): Map<number, IndexedLine> | null => {
    const entry = byPath.get(file) ?? byPath.get(file.replace(/^\.\//, ''));
    if (!entry) return null;
    return side === 'LEFT' ? entry.left : entry.right;
  };

  return {
    files: () => order,
    has: (file, side, line) => lookup(file, side)?.has(line) ?? false,
    lineText: (file, side, line) => lookup(file, side)?.get(line)?.text ?? null,
    excerpt: (file, side, line, context = 3) => {
      const entry = byPath.get(file) ?? byPath.get(file.replace(/^\.\//, ''));
      const hit = (side === 'LEFT' ? entry?.left : entry?.right)?.get(line);
      if (!entry || !hit) return null;
      const from = Math.max(0, hit.at - context);
      return entry.body.slice(from, hit.at + context + 1).join('\n');
    },
  };
}

export type AnchorProblem =
  /** The diff does not touch this file at all. */
  | 'unknown-file'
  /** The file is in the diff, but that line of it is not. */
  | 'off-diff'
  /** The line exists, but holds different text than the model quoted. */
  | 'text-mismatch'
  /** startLine/line describe an impossible range. */
  | 'bad-range';

/**
 * Validate one anchor. `quotedLine` is what the model claimed the line says,
 * and comparing it is the cheap hallucination detector: a model that invented
 * a line number usually invents its contents to match, and the two disagree
 * with the real diff in a way an off-by-one does not.
 *
 * Whitespace is normalised on both sides. Re-indentation is not the kind of
 * error worth discarding a real finding over.
 */
export function checkAnchor(
  index: AnchorIndex,
  anchor: { file: string; side: DiffSide; line: number; startLine: number | null },
  quotedLine?: string | null,
): AnchorProblem | null {
  if (index.files().length > 0 && !index.files().some((f) => f === anchor.file)) {
    // Not conclusive on its own — a rename alias still resolves in `has` — so
    // only report unknown-file when the line lookup also fails.
    if (index.lineText(anchor.file, anchor.side, anchor.line) === null) return 'unknown-file';
  }
  if (anchor.startLine !== null) {
    if (anchor.startLine > anchor.line) return 'bad-range';
    for (let l = anchor.startLine; l <= anchor.line; l++) {
      if (!index.has(anchor.file, anchor.side, l)) return 'off-diff';
    }
  } else if (!index.has(anchor.file, anchor.side, anchor.line)) {
    return 'off-diff';
  }
  if (quotedLine != null && quotedLine.trim() !== '') {
    const actual = index.lineText(anchor.file, anchor.side, anchor.line);
    if (actual === null) return 'off-diff';
    if (normalise(actual) !== normalise(quotedLine)) return 'text-mismatch';
  }
  return null;
}

function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Reassemble a unified diff from per-file patches.
 *
 * GitHub's files API is the only PR diff source that survives a large pull
 * request, and it returns patches per file rather than one document. Files with
 * no patch (binary, or too large for GitHub to diff) are skipped: nothing in
 * them can be anchored to anyway.
 */
export function unifiedDiffFromPatches(
  files: ReadonlyArray<{ filename: string; previousFilename?: string | null; patch?: string | null }>,
): string {
  const parts: string[] = [];
  for (const file of files) {
    if (!file.patch) continue;
    const from = file.previousFilename ?? file.filename;
    parts.push(`diff --git a/${from} b/${file.filename}\n${file.patch}`);
  }
  return parts.join('\n');
}
