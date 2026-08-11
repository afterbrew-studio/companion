import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { languageForPath, highlightLine } from './highlight.js';

/**
 * Unified-diff browser: a sidebar of changed files (with +/− counts) next to
 * the selected file's color-coded content, plus a full-screen mode for real
 * review work. Single-file diffs skip the sidebar.
 */

interface DiffLine {
  readonly kind: 'add' | 'del' | 'hunk' | 'ctx' | 'meta';
  readonly text: string;
  /**
   * Line numbers in the old and new file, null where the line does not exist on
   * that side. These are what an anchored annotation matches against, so the
   * counter arithmetic below has to agree with whatever produced the anchors.
   */
  readonly oldLine: number | null;
  readonly newLine: number | null;
}

interface DiffFile {
  readonly path: string;
  /** The `a/` path; differs from `path` only for a rename. */
  readonly fromPath: string;
  readonly adds: number;
  readonly dels: number;
  readonly lines: ReadonlyArray<DiffLine>;
}

/**
 * A note tied to one line of the diff: a gutter marker plus a row rendered
 * under that line. Deliberately content-agnostic — this component knows about
 * lines, not about whatever the caller is annotating them with.
 */
export interface DiffAnnotation {
  readonly id: string;
  /** File path as it appears in the diff (either side of a rename works). */
  readonly path: string;
  readonly side: 'LEFT' | 'RIGHT';
  readonly line: number;
  /** Shown in the gutter; falls back to a dot. */
  readonly marker?: React.ReactNode;
  readonly body: React.ReactNode;
}

/** Public so callers assembling per-file patches can stay below the renderer's memory ceiling. */
export const MAX_DIFF_CHARS = 400_000;
/** Lines pulled in per click when expanding context around a hunk. */
const EXPAND_LINES = 20;
/** Sentinel key for the after-the-last-hunk expansion, which has no hunk index. */
const TAIL_KEY = -1;
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** First line of the NEW file that a hunk header covers. */
function hunkStart(text: string): number {
  const m = text.match(HUNK_HEADER);
  return m ? Number(m[2]) : 1;
}

/** Highest new-file line already rendered before `index`; 0 before the first hunk. */
function lastShownLine(lines: ReadonlyArray<DiffLine>, index: number): number {
  for (let i = index - 1; i >= 0; i--) {
    const at = lines[i]!.newLine;
    if (at !== null) return at;
  }
  return 0;
}

export function parseDiff(diff: string): DiffFile[] {
  const files: Array<{ path: string; fromPath: string; adds: number; dels: number; lines: DiffLine[] }> = [];
  let current: (typeof files)[number] | null = null;
  let sawHunk = false;
  let oldLine = 0;
  let newLine = 0;

  const lines = diff.split('\n');
  // A diff ends with a newline, so the split leaves a trailing empty element.
  // Counting it as context would number a line that is not there.
  if (lines[lines.length - 1] === '') lines.pop();

  for (const line of lines) {
    const fileStart = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (fileStart) {
      const from = fileStart[1]!;
      current = { path: fileStart[2] ?? from, fromPath: from, adds: 0, dels: 0, lines: [] };
      files.push(current);
      sawHunk = false;
      continue;
    }
    if (!current) {
      // Diff without a git header (plain `diff`/patch) — collect under one file.
      current = { path: '', fromPath: '', adds: 0, dels: 0, lines: [] };
      files.push(current);
      sawHunk = false;
    }
    const hunk = line.match(HUNK_HEADER);
    if (hunk) {
      sawHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      current.lines.push({ kind: 'hunk', text: line, oldLine: null, newLine: null });
    } else if (line.startsWith('@@')) {
      // A malformed header still opens a hunk; without numbers to trust, the
      // lines under it simply carry none.
      sawHunk = true;
      current.lines.push({ kind: 'hunk', text: line, oldLine: null, newLine: null });
    } else if (!sawHunk) {
      // index/mode/---/+++ preamble
      current.lines.push({ kind: 'meta', text: line, oldLine: null, newLine: null });
    } else if (line.startsWith('+')) {
      current.adds++;
      current.lines.push({ kind: 'add', text: line, oldLine: null, newLine: newLine++ });
    } else if (line.startsWith('-')) {
      current.dels++;
      current.lines.push({ kind: 'del', text: line, oldLine: oldLine++, newLine: null });
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" belongs to the line above and counts on
      // neither side.
      current.lines.push({ kind: 'meta', text: line, oldLine: null, newLine: null });
    } else {
      current.lines.push({ kind: 'ctx', text: line, oldLine: oldLine++, newLine: newLine++ });
    }
  }
  return files;
}

const LINE_CLS: Record<DiffLine['kind'], string> = {
  add: 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-200',
  del: 'bg-red-500/10 text-red-800 dark:text-red-300',
  hunk: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800/70 dark:text-zinc-400',
  ctx: 'text-zinc-700 dark:text-zinc-300',
  meta: 'text-zinc-400 dark:text-zinc-500',
};

function Counts({ adds, dels }: { adds: number; dels: number }): React.JSX.Element {
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium tabular-nums">
      {adds > 0 ? <span className="text-emerald-600 dark:text-emerald-400">+{adds}</span> : null}
      {dels > 0 ? <span className="text-red-600 dark:text-red-400">−{dels}</span> : null}
    </span>
  );
}

// ---------- file tree --------------------------------------------------------
// The sidebar shows the changed files as a directory tree (basenames indented
// under their folders) instead of a flat list of middle-truncated paths.

interface DirNode {
  readonly type: 'dir';
  readonly name: string;
  /** Full path of this directory, used as a stable collapse key. */
  readonly path: string;
  children: TreeNode[];
}
interface FileNode {
  readonly type: 'file';
  readonly name: string;
  readonly path: string;
  /** Index into the flat `files` array — what selection refers to. */
  readonly index: number;
  readonly adds: number;
  readonly dels: number;
}
type TreeNode = DirNode | FileNode;

function buildTree(files: DiffFile[]): TreeNode[] {
  const root: DirNode = { type: 'dir', name: '', path: '', children: [] };
  files.forEach((f, index) => {
    const full = f.path || 'changes';
    const parts = full.split('/');
    const fileName = parts.pop()!;
    let dir = root;
    let acc = '';
    for (const seg of parts) {
      acc = acc ? `${acc}/${seg}` : seg;
      let next = dir.children.find((c): c is DirNode => c.type === 'dir' && c.name === seg);
      if (!next) {
        next = { type: 'dir', name: seg, path: acc, children: [] };
        dir.children.push(next);
      }
      dir = next;
    }
    dir.children.push({ type: 'file', name: fileName, path: full, index, adds: f.adds, dels: f.dels });
  });
  normalize(root);
  return root.children;
}

/** Collapse single-child directory chains (a/ → b/ → file becomes "a/b") and sort. */
function normalize(dir: DirNode): void {
  for (const c of dir.children) if (c.type === 'dir') normalize(c);
  dir.children = dir.children.map((c) => {
    if (c.type !== 'dir') return c;
    let node = c;
    while (node.children.length === 1 && node.children[0]!.type === 'dir') {
      const only = node.children[0] as DirNode;
      node = { type: 'dir', name: `${node.name}/${only.name}`, path: only.path, children: only.children };
    }
    return node;
  });
  dir.children.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)));
}

interface TreeRow {
  readonly depth: number;
  readonly node: TreeNode;
}
function flattenTree(nodes: TreeNode[], collapsed: ReadonlySet<string>, depth = 0, out: TreeRow[] = []): TreeRow[] {
  for (const n of nodes) {
    out.push({ depth, node: n });
    if (n.type === 'dir' && !collapsed.has(n.path)) flattenTree(n.children, collapsed, depth + 1, out);
  }
  return out;
}

function Caret({ open }: { open: boolean }): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className={`size-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden>
      <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Annotations of one file, keyed by the line they hang off. */
function annotationsByLine(
  file: DiffFile,
  annotations: readonly DiffAnnotation[],
): Map<string, DiffAnnotation[]> {
  const map = new Map<string, DiffAnnotation[]>();
  for (const a of annotations) {
    if (a.path !== file.path && a.path !== file.fromPath) continue;
    const key = `${a.side}:${a.line}`;
    const bucket = map.get(key);
    if (bucket) bucket.push(a);
    else map.set(key, [a]);
  }
  return map;
}

function FileLines({
  file,
  annotations = [],
  focusedAnnotationId = null,
  onFocusAnnotation,
  onAddComment,
  onExpandContext,
}: {
  file: DiffFile;
  annotations?: readonly DiffAnnotation[];
  focusedAnnotationId?: string | null;
  onFocusAnnotation?: (id: string) => void;
  onAddComment?: (path: string, side: 'LEFT' | 'RIGHT', line: number) => void;
  onExpandContext?: (path: string, from: number, to: number) => Promise<string[]>;
}): React.JSX.Element {
  const lang = useMemo(() => languageForPath(file.path), [file.path]);
  const anchored = useMemo(() => annotationsByLine(file, annotations), [file, annotations]);
  const focusedRef = useRef<HTMLDivElement>(null);
  /** Lines pulled in above a hunk, keyed by that hunk's index in `file.lines`. */
  const [expanded, setExpanded] = useState<Record<number, { from: number; lines: string[] }>>({});
  /** Lines pulled in after the last hunk, which no header sits below. */
  const [tail, setTail] = useState<{ from: number; lines: string[] } | null>(null);
  const [expanding, setExpanding] = useState<number | null>(null);

  // A different file reuses this component; its expansions are not ours.
  useEffect(() => {
    setExpanded({});
    setTail(null);
  }, [file]);

  /**
   * Lines after the final hunk. Unlike a gap between hunks there is no ceiling
   * to stop at, so it simply runs until the file does — an empty answer.
   */
  const expandTail = async (after: number): Promise<void> => {
    if (!onExpandContext) return;
    const from = tail ? tail.from + tail.lines.length : after + 1;
    setExpanding(TAIL_KEY);
    try {
      const lines = await onExpandContext(file.path, from, from + EXPAND_LINES - 1);
      if (lines.length === 0) return;
      setTail((prev) => (prev ? { ...prev, lines: [...prev.lines, ...lines] } : { from, lines }));
    } finally {
      setExpanding(null);
    }
  };

  const expand = async (at: number, hunkStart: number, floor: number): Promise<void> => {
    if (!onExpandContext) return;
    const already = expanded[at];
    const to = (already?.from ?? hunkStart) - 1;
    if (to < floor) return;
    const from = Math.max(floor, to - EXPAND_LINES + 1);
    setExpanding(at);
    try {
      const lines = await onExpandContext(file.path, from, to);
      if (lines.length === 0) return;
      setExpanded((prev) => {
        const prior = prev[at];
        return { ...prev, [at]: { from, lines: prior ? [...lines, ...prior.lines] : lines } };
      });
    } finally {
      setExpanding(null);
    }
  };

  // Selecting a finding elsewhere has to bring its line into view; without this
  // the two-way link only works in one direction.
  useEffect(() => {
    if (focusedAnnotationId && focusedRef.current) {
      focusedRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [focusedAnnotationId, file]);

  /** Last new-file line the diff itself shows; 0 when it shows none. */
  const lastLine = lastShownLine(file.lines, file.lines.length);

  const gutter = (line: DiffLine): React.JSX.Element => {
    // A deletion is addressable on the LEFT, everything else on the RIGHT —
    // the same rule GitHub applies to where a comment may hang.
    const side: 'LEFT' | 'RIGHT' = line.kind === 'del' ? 'LEFT' : 'RIGHT';
    const at = side === 'LEFT' ? line.oldLine : line.newLine;
    return (
      <>
        <span className="dim inline-block w-10 shrink-0 pr-2 text-right tabular-nums select-none">
          {line.oldLine ?? ''}
        </span>
        <span className="dim inline-block w-10 shrink-0 pr-2 text-right tabular-nums select-none">
          {line.newLine ?? ''}
        </span>
        {onAddComment ? (
          at !== null ? (
            <button
              type="button"
              className="mr-1 w-4 shrink-0 cursor-pointer text-accent-500 opacity-0 transition-opacity select-none group-hover:opacity-100"
              onClick={() => onAddComment(file.path, side, at)}
              aria-label={`Comment on line ${at}`}
              title="Comment on this line"
            >
              +
            </button>
          ) : (
            <span className="mr-1 inline-block w-4 shrink-0 select-none" />
          )
        ) : null}
      </>
    );
  };

  return (
    <div className="min-w-0 flex-1 overflow-auto font-mono text-xs leading-5">
      {file.lines.map((line, li) => {
        // Hunk/meta lines are diff chrome, not source — leave them unhighlighted.
        if (line.kind === 'hunk' || line.kind === 'meta') {
          if (line.kind !== 'hunk' || !onExpandContext) {
            return (
              <div key={li} className={`px-3 whitespace-pre ${LINE_CLS[line.kind]}`}>
                {line.text || ' '}
              </div>
            );
          }
          const start = hunkStart(line.text);
          const shown = expanded[li];
          // Never reach back into the previous hunk: those lines are already on
          // screen, and pulling them in again renders them twice.
          const floor = lastShownLine(file.lines, li) + 1;
          const more = (shown?.from ?? start) > floor;
          return (
            <div key={li}>
              <div className={`flex items-center px-3 whitespace-pre ${LINE_CLS.hunk}`}>
                {more ? (
                  <button
                    type="button"
                    className="mr-2 cursor-pointer rounded px-1 hover:bg-zinc-200 dark:hover:bg-zinc-700"
                    onClick={() => void expand(li, start, floor)}
                    title={`Show ${EXPAND_LINES} more lines above`}
                    aria-label="Expand context above"
                  >
                    {expanding === li ? '…' : '↑'}
                  </button>
                ) : null}
                <span>{line.text || ' '}</span>
              </div>
              {shown?.lines.map((text, i) => (
                <div key={`x${i}`} className={`flex px-3 whitespace-pre ${LINE_CLS.ctx} opacity-70`}>
                  <span className="dim inline-block w-10 shrink-0 pr-2 text-right tabular-nums select-none" />
                  <span className="dim inline-block w-10 shrink-0 pr-2 text-right tabular-nums select-none">
                    {shown.from + i}
                  </span>
                  {onAddComment ? <span className="mr-1 inline-block w-4 shrink-0" /> : null}
                  <span className="mr-1 inline-block w-3 shrink-0" />
                  <span className="select-none"> </span>
                  <span dangerouslySetInnerHTML={{ __html: highlightLine(text, lang) }} />
                </div>
              ))}
            </div>
          );
        }
        // A deletion is addressed on the LEFT, everything else on the RIGHT.
        const here = [
          ...(line.newLine !== null ? (anchored.get(`RIGHT:${line.newLine}`) ?? []) : []),
          ...(line.oldLine !== null && line.kind === 'del' ? (anchored.get(`LEFT:${line.oldLine}`) ?? []) : []),
        ];
        // Split the +/−/space marker from the code so highlighting sees only source.
        const marker = line.text.slice(0, 1);
        const code = line.text.slice(1);
        const focused = here.some((a) => a.id === focusedAnnotationId);
        return (
          <div key={li} ref={focused ? focusedRef : undefined}>
            <div
              className={`group flex px-3 whitespace-pre ${LINE_CLS[line.kind]} ${
                focused ? 'ring-1 ring-inset ring-accent-500/70' : ''
              }`}
            >
              {gutter(line)}
              {here.length > 0 ? (
                <button
                  type="button"
                  className="mr-1 shrink-0 cursor-pointer select-none"
                  onClick={() => onFocusAnnotation?.(here[0]!.id)}
                  title="Jump to this finding"
                >
                  {here[0]!.marker ?? <span className="text-accent-500">●</span>}
                </button>
              ) : (
                <span className="mr-1 inline-block w-3 shrink-0 select-none" />
              )}
              <span className="select-none">{marker || ' '}</span>
              <span dangerouslySetInnerHTML={{ __html: highlightLine(code, lang) }} />
            </div>
            {here.map((a) => (
              <div key={a.id} className="border-y border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/60">
                {a.body}
              </div>
            ))}
          </div>
        );
      })}

      {onExpandContext && lastLine > 0 ? (
        <>
          {tail?.lines.map((text, i) => (
            <div key={`t${i}`} className={`flex px-3 whitespace-pre ${LINE_CLS.ctx} opacity-70`}>
              <span className="dim inline-block w-10 shrink-0 pr-2 text-right tabular-nums select-none" />
              <span className="dim inline-block w-10 shrink-0 pr-2 text-right tabular-nums select-none">
                {tail.from + i}
              </span>
              {onAddComment ? <span className="mr-1 inline-block w-4 shrink-0" /> : null}
              <span className="mr-1 inline-block w-3 shrink-0" />
              <span className="select-none"> </span>
              <span dangerouslySetInnerHTML={{ __html: highlightLine(text, lang) }} />
            </div>
          ))}
          <button
            type="button"
            className={`flex w-full cursor-pointer items-center px-3 ${LINE_CLS.hunk} hover:bg-zinc-200 dark:hover:bg-zinc-700`}
            onClick={() => void expandTail(lastLine)}
            title={`Show ${EXPAND_LINES} more lines below`}
            aria-label="Expand context below"
          >
            {expanding === TAIL_KEY ? '…' : '↓'}
          </button>
        </>
      ) : null}
    </div>
  );
}

function Browser({
  files,
  selected,
  onSelect,
  heightCls,
  resizable = false,
  annotations = [],
  focusedAnnotationId = null,
  onFocusAnnotation,
  onAddComment,
  onExpandContext,
}: {
  files: DiffFile[];
  selected: number;
  onSelect: (i: number) => void;
  heightCls: string;
  /** Full-screen mode: let the user drag the file-list / preview split. */
  resizable?: boolean;
  annotations?: readonly DiffAnnotation[];
  focusedAnnotationId?: string | null;
  onFocusAnnotation?: (id: string) => void;
  onAddComment?: (path: string, side: 'LEFT' | 'RIGHT', line: number) => void;
  onExpandContext?: (path: string, from: number, to: number) => Promise<string[]>;
}): React.JSX.Element {
  const file = files[Math.min(selected, files.length - 1)]!;
  const tree = useMemo(() => buildTree(files), [files]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const rows = useMemo(() => flattenTree(tree, collapsed), [tree, collapsed]);
  const [navWidth, setNavWidth] = useState(224); // matches w-56
  const toggleDir = (path: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const startResize = (e: React.PointerEvent): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = navWidth;
    const max = Math.max(280, Math.min(window.innerWidth - 320, window.innerWidth * 0.7));
    const onMove = (ev: PointerEvent): void =>
      setNavWidth(Math.min(Math.max(startW + ev.clientX - startX, 160), max));
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    document.body.style.userSelect = 'none';
  };

  return (
    <div className={`flex min-h-0 ${heightCls}`}>
      {files.length > 1 ? (
        <nav
          className={`shrink-0 overflow-y-auto border-r border-zinc-200 bg-zinc-50 py-1 dark:border-zinc-800 dark:bg-zinc-900/60 ${resizable ? '' : 'w-56'}`}
          style={resizable ? { width: navWidth } : undefined}
          aria-label="Changed files"
        >
          {rows.map(({ depth, node }) => {
            const pad = { paddingLeft: `${6 + depth * 12}px` };
            if (node.type === 'dir') {
              return (
                <button
                  key={`d:${node.path}`}
                  type="button"
                  className="dim flex w-full cursor-pointer items-center gap-1 py-1 pr-2 text-left transition-colors hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-200"
                  style={pad}
                  onClick={() => toggleDir(node.path)}
                  title={node.path}
                  aria-expanded={!collapsed.has(node.path)}
                >
                  <Caret open={!collapsed.has(node.path)} />
                  <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{node.name}</span>
                </button>
              );
            }
            return (
              <button
                key={`f:${node.index}`}
                type="button"
                className={`flex w-full cursor-pointer items-center gap-2 py-1 pr-2 text-left transition-colors ${
                  node.index === selected
                    ? 'bg-white font-medium dark:bg-zinc-800'
                    : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/60'
                }`}
                style={pad}
                onClick={() => onSelect(node.index)}
                title={node.path}
              >
                <span className="min-w-0 flex-1 truncate text-[11px]">{node.name}</span>
                <Counts adds={node.adds} dels={node.dels} />
              </button>
            );
          })}
        </nav>
      ) : null}
      {resizable && files.length > 1 ? (
        <div
          role="separator"
          aria-orientation="vertical"
          className="w-1 shrink-0 cursor-col-resize bg-zinc-200 transition-colors hover:bg-[#3987e5] dark:bg-zinc-800"
          onPointerDown={startResize}
          title="Drag to resize"
        />
      ) : null}
      <FileLines
        file={file}
        annotations={annotations}
        focusedAnnotationId={focusedAnnotationId}
        {...(onFocusAnnotation ? { onFocusAnnotation } : {})}
        {...(onAddComment ? { onAddComment } : {})}
        {...(onExpandContext ? { onExpandContext } : {})}
      />
    </div>
  );
}

export function DiffView({
  diff,
  className = '',
  annotations = [],
  focusedAnnotationId = null,
  onFocusAnnotation,
  onAddComment,
  onExpandContext,
}: {
  diff: string;
  className?: string;
  annotations?: readonly DiffAnnotation[];
  /** Selecting one elsewhere reveals its line here, switching file if needed. */
  focusedAnnotationId?: string | null;
  onFocusAnnotation?: (id: string) => void;
  /** Offer a per-line affordance for starting a comment. */
  onAddComment?: (path: string, side: 'LEFT' | 'RIGHT', line: number) => void;
  /** Fetch lines of the new file so hunks can be expanded beyond their context. */
  onExpandContext?: (path: string, from: number, to: number) => Promise<string[]>;
}): React.JSX.Element {
  const truncated = diff.length > MAX_DIFF_CHARS;
  const files = useMemo(() => parseDiff(truncated ? diff.slice(0, MAX_DIFF_CHARS) : diff), [diff, truncated]);
  const [selected, setSelected] = useState(0);
  const [full, setFull] = useState(false);

  // Diff replaced (new run/refresh) — snap back to the first file.
  useEffect(() => {
    setSelected(0);
  }, [diff]);

  // A focused annotation usually lives in a file that is not on screen, so the
  // selection follows it before FileLines tries to scroll to the line.
  useEffect(() => {
    if (!focusedAnnotationId) return;
    const target = annotations.find((a) => a.id === focusedAnnotationId);
    if (!target) return;
    const index = files.findIndex((f) => f.path === target.path || f.fromPath === target.path);
    if (index >= 0) setSelected(index);
  }, [focusedAnnotationId, annotations, files]);

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setFull(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full]);

  if (files.length === 0) return <div className={`dim ${className}`}>No changes.</div>;

  const totals = files.reduce((acc, f) => ({ adds: acc.adds + f.adds, dels: acc.dels + f.dels }), { adds: 0, dels: 0 });
  const sel = Math.min(selected, files.length - 1);

  const toolbar = (
    <div className="flex items-center gap-2.5 border-b border-zinc-200 bg-zinc-50 px-3 py-1.5 dark:border-zinc-800 dark:bg-zinc-900">
      {files.length > 1 ? (
        <span className="dim shrink-0">
          {files.length} file{files.length === 1 ? '' : 's'}
        </span>
      ) : (
        <code className="min-w-0 flex-1 truncate text-xs font-medium">{files[0]!.path || 'changes'}</code>
      )}
      <Counts adds={totals.adds} dels={totals.dels} />
      <span className="flex-1" />
      {truncated ? <span className="dim shrink-0">truncated at {Math.round(MAX_DIFF_CHARS / 1000)}k chars</span> : null}
      <button
        className="dim shrink-0 cursor-pointer rounded p-1 transition-colors hover:bg-zinc-200 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        onClick={() => setFull((v) => !v)}
        aria-label={full ? 'Exit full screen' : 'View diff full screen'}
        title={full ? 'Exit full screen (Esc)' : 'Full screen'}
      >
        {full ? (
          <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden>
            <path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden>
            <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>
    </div>
  );

  return (
    <>
      <div className={`overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800 ${className}`}>
        {toolbar}
        <Browser
          files={files}
          selected={sel}
          onSelect={setSelected}
          heightCls="max-h-96"
          annotations={annotations}
          focusedAnnotationId={focusedAnnotationId}
          {...(onFocusAnnotation ? { onFocusAnnotation } : {})}
          {...(onAddComment ? { onAddComment } : {})}
          {...(onExpandContext ? { onExpandContext } : {})}
        />
      </div>
      {full
        ? createPortal(
            <div
              className="fixed inset-0 z-50 flex flex-col bg-white dark:bg-zinc-950"
              role="dialog"
              aria-modal="true"
              aria-label="Diff full screen"
            >
              {toolbar}
              <Browser
                files={files}
                selected={sel}
                onSelect={setSelected}
                heightCls="flex-1"
                resizable
                annotations={annotations}
                focusedAnnotationId={focusedAnnotationId}
                {...(onFocusAnnotation ? { onFocusAnnotation } : {})}
                {...(onAddComment ? { onAddComment } : {})}
                {...(onExpandContext ? { onExpandContext } : {})}
              />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
