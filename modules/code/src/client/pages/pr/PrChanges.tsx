import { useEffect, useState } from 'react';
import { ChevronDown, DiffView, Spinner, type DiffAnnotation } from '@moxxy/companion-sdk/ui';
import type { PrFileChange } from '../../../contract/index.js';

/**
 * The PR's changed files, loaded lazily and collapsed by default: the header
 * shows the files-changed count and the added/removed totals, expanding to the
 * per-file diff browser.
 *
 * PRs load through the paginated files API (`fetchFiles`) — resilient to large
 * PRs the single `.diff` payload rejects — and the diff is reconstructed from
 * the per-file patches. The build view has only a raw run diff, so it passes
 * `fetchDiff` instead. Exactly one source should be given, and it must be
 * stable (memoize at the call site) so the fetch runs once.
 */
interface Loaded {
  readonly diff: string;
  readonly files: number;
  readonly added: number;
  readonly removed: number;
  readonly hidden: number;
  readonly truncated: boolean;
}

export function PrChanges({
  fetchFiles,
  fetchDiff,
  annotations = [],
  focusedAnnotationId = null,
  onFocusAnnotation,
  onAddComment,
  onExpandContext,
}: {
  fetchFiles?: () => Promise<{ files: PrFileChange[]; truncated: boolean }>;
  fetchDiff?: () => Promise<string>;
  annotations?: readonly DiffAnnotation[];
  focusedAnnotationId?: string | null;
  onFocusAnnotation?: (id: string) => void;
  onAddComment?: (path: string, side: 'LEFT' | 'RIGHT', line: number) => void;
  onExpandContext?: (path: string, from: number, to: number) => Promise<string[]>;
}): JSX.Element {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);

  // Selecting a finding has to open the section it lives in, or the jump lands
  // on a collapsed panel and looks like nothing happened.
  useEffect(() => {
    if (focusedAnnotationId) setOpen(true);
  }, [focusedAnnotationId]);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(false);
    const load = async (): Promise<Loaded> => {
      if (fetchFiles) {
        const { files, truncated } = await fetchFiles();
        return { ...fromFiles(files), truncated };
      }
      return { ...fromDiff(await fetchDiff!()), truncated: false };
    };
    load()
      .then((d) => alive && setData(d))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [fetchFiles, fetchDiff]);

  const hasChanges = !!data && data.files > 0;

  return (
    <section className="card" aria-label="Changed files">
      <button
        type="button"
        className={`flex w-full items-center gap-2.5 text-left ${hasChanges ? 'cursor-pointer' : 'cursor-default'}`}
        onClick={() => hasChanges && setOpen((v) => !v)}
        aria-expanded={open}
        disabled={!hasChanges}
      >
        <strong className="text-sm">Changed files</strong>
        {!data && !error ? (
          <span className="dim flex items-center gap-1.5">
            <Spinner /> loading…
          </span>
        ) : null}
        {error ? <span className="badge-danger">unavailable</span> : null}
        {data && data.files > 0 ? (
          <span className="flex items-center gap-2.5 text-xs">
            <span className="dim tabular-nums">
              {data.files} file{data.files === 1 ? '' : 's'}
            </span>
            <span className="font-medium text-emerald-600 tabular-nums dark:text-emerald-400">+{data.added}</span>
            <span className="font-medium text-red-600 tabular-nums dark:text-red-400">−{data.removed}</span>
          </span>
        ) : null}
        {data && data.files === 0 ? <span className="dim">no file changes</span> : null}
        {annotations.length > 0 ? (
          <span className="badge-warn">
            {annotations.length} finding{annotations.length === 1 ? '' : 's'}
          </span>
        ) : null}
        <span className="flex-1" />
        {hasChanges ? <ChevronDown open={open} className="dim size-4 shrink-0" /> : null}
      </button>

      {open && data ? (
        <div className="mt-3 flex flex-col gap-2">
          {data.diff.trim() ? (
            <DiffView
              diff={data.diff}
              annotations={annotations}
              focusedAnnotationId={focusedAnnotationId}
              {...(onFocusAnnotation ? { onFocusAnnotation } : {})}
              {...(onAddComment ? { onAddComment } : {})}
              {...(onExpandContext ? { onExpandContext } : {})}
            />
          ) : null}
          {data.hidden > 0 ? (
            <p className="dim text-xs">
              {data.hidden} file{data.hidden === 1 ? '' : 's'} not shown (binary or too large to diff).
            </p>
          ) : null}
          {data.truncated ? (
            <div className="banner-warn text-xs">This pull request is very large — showing the first batch of files.</div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** Reconstruct a unified diff from GitHub's per-file patches for DiffView. */
function fromFiles(files: PrFileChange[]): Omit<Loaded, 'truncated'> {
  let added = 0;
  let removed = 0;
  let hidden = 0;
  const parts: string[] = [];
  for (const f of files) {
    added += f.additions;
    removed += f.deletions;
    if (f.patch) {
      const from = f.previousFilename ?? f.filename;
      parts.push(`diff --git a/${from} b/${f.filename}\n${f.patch}`);
    } else {
      hidden++;
    }
  }
  return { diff: parts.join('\n'), files: files.length, added, removed, hidden };
}

/** Summarise a raw unified diff string (the build view's run diff). */
function fromDiff(diff: string): Omit<Loaded, 'truncated'> {
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) files++;
    else if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { diff, files, added, removed, hidden: 0 };
}
