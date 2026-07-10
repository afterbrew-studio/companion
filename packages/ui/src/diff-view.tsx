import { useEffect, useMemo, useState } from 'react';
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
}

interface DiffFile {
  readonly path: string;
  readonly adds: number;
  readonly dels: number;
  readonly lines: ReadonlyArray<DiffLine>;
}

const MAX_DIFF_CHARS = 400_000;

function parseDiff(diff: string): DiffFile[] {
  const files: Array<{ path: string; adds: number; dels: number; lines: DiffLine[] }> = [];
  let current: (typeof files)[number] | null = null;
  let sawHunk = false;

  for (const line of diff.split('\n')) {
    const fileStart = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (fileStart) {
      current = { path: fileStart[2] ?? fileStart[1]!, adds: 0, dels: 0, lines: [] };
      files.push(current);
      sawHunk = false;
      continue;
    }
    if (!current) {
      // Diff without a git header (plain `diff`/patch) — collect under one file.
      current = { path: '', adds: 0, dels: 0, lines: [] };
      files.push(current);
      sawHunk = false;
    }
    if (line.startsWith('@@')) {
      sawHunk = true;
      current.lines.push({ kind: 'hunk', text: line });
    } else if (!sawHunk) {
      // index/mode/---/+++ preamble
      current.lines.push({ kind: 'meta', text: line });
    } else if (line.startsWith('+')) {
      current.adds++;
      current.lines.push({ kind: 'add', text: line });
    } else if (line.startsWith('-')) {
      current.dels++;
      current.lines.push({ kind: 'del', text: line });
    } else {
      current.lines.push({ kind: 'ctx', text: line });
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

function Counts({ adds, dels }: { adds: number; dels: number }): JSX.Element {
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

function Caret({ open }: { open: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className={`size-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden>
      <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FileLines({ file }: { file: DiffFile }): JSX.Element {
  const lang = useMemo(() => languageForPath(file.path), [file.path]);
  return (
    <div className="min-w-0 flex-1 overflow-auto font-mono text-xs leading-5">
      {file.lines.map((line, li) => {
        // Hunk/meta lines are diff chrome, not source — leave them unhighlighted.
        if (line.kind === 'hunk' || line.kind === 'meta') {
          return (
            <div key={li} className={`px-3 whitespace-pre ${LINE_CLS[line.kind]}`}>
              {line.text || ' '}
            </div>
          );
        }
        // Split the +/−/space marker from the code so highlighting sees only source.
        const marker = line.text.slice(0, 1);
        const code = line.text.slice(1);
        return (
          <div key={li} className={`px-3 whitespace-pre ${LINE_CLS[line.kind]}`}>
            <span className="select-none">{marker || ' '}</span>
            <span dangerouslySetInnerHTML={{ __html: highlightLine(code, lang) }} />
          </div>
        );
      })}
    </div>
  );
}

function Browser({
  files,
  selected,
  onSelect,
  heightCls,
  resizable = false,
}: {
  files: DiffFile[];
  selected: number;
  onSelect: (i: number) => void;
  heightCls: string;
  /** Full-screen mode: let the user drag the file-list / preview split. */
  resizable?: boolean;
}): JSX.Element {
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
      <FileLines file={file} />
    </div>
  );
}

export function DiffView({ diff, className = '' }: { diff: string; className?: string }): JSX.Element {
  const truncated = diff.length > MAX_DIFF_CHARS;
  const files = useMemo(() => parseDiff(truncated ? diff.slice(0, MAX_DIFF_CHARS) : diff), [diff, truncated]);
  const [selected, setSelected] = useState(0);
  const [full, setFull] = useState(false);

  // Diff replaced (new run/refresh) — snap back to the first file.
  useEffect(() => {
    setSelected(0);
  }, [diff]);

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
        <Browser files={files} selected={sel} onSelect={setSelected} heightCls="max-h-96" />
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
              <Browser files={files} selected={sel} onSelect={setSelected} heightCls="flex-1" resizable />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
