import { useEffect, useRef, useState } from 'react';
import { ChevronDown, DiffView, MAX_DIFF_CHARS, Spinner, type DiffAnnotation } from '@moxxy/companion-sdk/ui';
import type { PrFileChange, PrFileChangesPage } from '../../../contract/index.js';

/**
 * The PR's changed files, loaded lazily and collapsed by default: the header
 * shows the files-changed count and the added/removed totals, expanding to the
 * per-file diff browser.
 *
 * PRs load one bounded page from the files API (`fetchFiles`) — resilient to
 * large PRs the single `.diff` payload rejects — and the diff is reconstructed
 * from those patches. Previous/next pages replace the current window instead
 * of accumulating every patch in browser memory. The build view has only a raw
 * run diff, so it passes `fetchDiff` instead. Exactly one source should be
 * given, and it must be stable (memoize at the call site).
 */
interface Loaded {
  readonly diff: string;
  readonly files: number;
  readonly added: number;
  readonly removed: number;
  readonly hidden: number;
  readonly omitted: number;
  readonly pagePaths: ReadonlyArray<string>;
  readonly renderedPaths: ReadonlyArray<string>;
  readonly page: number;
  readonly pageSize: number;
  readonly hasNextPage: boolean;
}

/** Back/forward stays instant without slowly rebuilding the original unbounded response in memory. */
const MAX_CACHED_FILE_PAGES = 3;

export function PrChanges({
  fetchFiles,
  fetchDiff,
  annotations = [],
  focusedAnnotationId = null,
  onFocusAnnotation,
  onAddComment,
  onExpandContext,
}: {
  fetchFiles?: (page: number) => Promise<PrFileChangesPage>;
  fetchDiff?: () => Promise<string>;
  annotations?: readonly DiffAnnotation[];
  focusedAnnotationId?: string | null;
  onFocusAnnotation?: (id: string) => void;
  onAddComment?: (path: string, side: 'LEFT' | 'RIGHT', line: number) => void;
  onExpandContext?: (path: string, from: number, to: number) => Promise<string[]>;
}): React.JSX.Element {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [requestedPage, setRequestedPage] = useState(1);
  const [retryKey, setRetryKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const pageCache = useRef(new Map<number, Loaded>());

  // Selecting a finding has to open the section it lives in, or the jump lands
  // on a collapsed panel and looks like nothing happened.
  useEffect(() => {
    if (focusedAnnotationId) setOpen(true);
  }, [focusedAnnotationId]);

  useEffect(() => {
    pageCache.current.clear();
    setRequestedPage(1);
    setData(null);
    setError(null);
    setLoading(true);
  }, [fetchFiles, fetchDiff]);

  useEffect(() => {
    let alive = true;
    const page = fetchFiles ? requestedPage : 1;
    const cached = pageCache.current.get(page);
    if (cached) {
      pageCache.current.delete(page);
      pageCache.current.set(page, cached);
      setData(cached);
      setError(null);
      setLoading(false);
      return () => {
        alive = false;
      };
    }

    setError(null);
    setLoading(true);
    const load = async (): Promise<Loaded> => {
      if (fetchFiles) {
        const result = await fetchFiles(page);
        if (result.page !== page) throw new Error(`GitHub returned page ${result.page} while page ${page} was requested`);
        return {
          ...fromFiles(result.files),
          page: result.page,
          pageSize: result.pageSize,
          hasNextPage: result.hasNextPage,
        };
      }
      const loaded = fromDiff(await fetchDiff!());
      return { ...loaded, page: 1, pageSize: loaded.files, hasNextPage: false };
    };
    load()
      .then((loaded) => {
        if (!alive) return;
        rememberPage(pageCache.current, loaded);
        setData(loaded);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(describeLoadError(err));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [fetchFiles, fetchDiff, requestedPage, retryKey]);

  const hasChanges = !!data && data.files > 0;
  const focused = focusedAnnotationId ? annotations.find((annotation) => annotation.id === focusedAnnotationId) : undefined;
  const focusedOnPage = focused ? data?.pagePaths.includes(focused.path) ?? false : true;
  const focusedRendered = focused ? data?.renderedPaths.includes(focused.path) ?? false : true;

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
        {!data && loading ? (
          <span className="dim flex items-center gap-1.5">
            <Spinner /> loading…
          </span>
        ) : null}
        {loading && data ? (
          <span className="dim flex items-center gap-1.5" role="status">
            <Spinner /> page {requestedPage}…
          </span>
        ) : null}
        {error ? <span className="badge-danger">{data ? 'page unavailable' : 'unavailable'}</span> : null}
        {data && data.files > 0 ? (
          <span className="flex items-center gap-2.5 text-xs">
            <span className="dim tabular-nums">
              {fileWindowLabel(data)}
            </span>
            <span title="Additions on this page" className="font-medium text-emerald-600 tabular-nums dark:text-emerald-400">
              +{data.added}
            </span>
            <span title="Deletions on this page" className="font-medium text-red-600 tabular-nums dark:text-red-400">
              −{data.removed}
            </span>
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

      {error ? (
        <div className="error-bar mt-2 flex items-center gap-3" role="alert">
          <span className="min-w-0 flex-1">{error}</span>
          <button type="button" className="btn-ghost shrink-0 text-xs" disabled={loading} onClick={() => setRetryKey((v) => v + 1)}>
            Retry
          </button>
        </div>
      ) : null}

      {open && data ? (
        <div className="mt-3 flex flex-col gap-2">
          {fetchFiles && (data.page > 1 || data.hasNextPage) ? (
            <nav className="flex flex-wrap items-center gap-2" aria-label="Changed file pages">
              <span className="dim min-w-0 flex-1 tabular-nums" aria-live="polite">
                {loading ? `Loading page ${requestedPage}…` : fileRangeLabel(data)}
              </span>
              <button
                type="button"
                className="btn-ghost text-xs"
                disabled={loading || data.page <= 1}
                onClick={() => setRequestedPage(Math.max(1, data.page - 1))}
              >
                Previous
              </button>
              <button
                type="button"
                className="btn-ghost text-xs"
                disabled={loading || !data.hasNextPage}
                onClick={() => setRequestedPage(data.page + 1)}
              >
                Next
              </button>
            </nav>
          ) : null}
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
          {data.omitted > 0 ? (
            <div className="banner-warn text-xs">
              {data.omitted} patch{data.omitted === 1 ? '' : 'es'} on this page omitted from the browser to keep it responsive.
            </div>
          ) : null}
          {focused && !focusedOnPage ? (
            <div className="banner-warn text-xs">
              The selected finding is in <code>{focused.path}</code>, outside the currently loaded file page. Move between pages to open its diff.
            </div>
          ) : null}
          {focused && focusedOnPage && !focusedRendered ? (
            <div className="banner-warn text-xs">
              The selected finding is in <code>{focused.path}</code>, but GitHub did not provide a renderable patch within this page's display budget.
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** Reconstruct a unified diff from GitHub's per-file patches for DiffView. */
function fromFiles(
  files: ReadonlyArray<PrFileChange>,
): Omit<Loaded, 'page' | 'pageSize' | 'hasNextPage'> {
  let added = 0;
  let removed = 0;
  let hidden = 0;
  let omitted = 0;
  let diffChars = 0;
  const parts: string[] = [];
  const pagePaths: string[] = [];
  const renderedPaths: string[] = [];
  for (const f of files) {
    added += f.additions;
    removed += f.deletions;
    pagePaths.push(f.filename, ...(f.previousFilename ? [f.previousFilename] : []));
    if (f.patch) {
      const from = f.previousFilename ?? f.filename;
      const part = `diff --git a/${from} b/${f.filename}\n${f.patch}`;
      const separator = parts.length > 0 ? 1 : 0;
      if (diffChars + separator + part.length <= MAX_DIFF_CHARS) {
        parts.push(part);
        diffChars += separator + part.length;
        renderedPaths.push(f.filename, ...(f.previousFilename ? [f.previousFilename] : []));
      } else {
        omitted++;
      }
    } else {
      hidden++;
    }
  }
  return {
    diff: parts.join('\n'),
    files: files.length,
    added,
    removed,
    hidden,
    omitted,
    pagePaths,
    renderedPaths,
  };
}

/** Summarise a raw unified diff string (the build view's run diff). */
function fromDiff(diff: string): Omit<Loaded, 'page' | 'pageSize' | 'hasNextPage'> {
  let files = 0;
  let added = 0;
  let removed = 0;
  const paths: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      files++;
      const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (match) paths.push(match[1]!, match[2]!);
    }
    else if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { diff, files, added, removed, hidden: 0, omitted: 0, pagePaths: paths, renderedPaths: paths };
}

function rememberPage(cache: Map<number, Loaded>, loaded: Loaded): void {
  cache.delete(loaded.page);
  cache.set(loaded.page, loaded);
  while (cache.size > MAX_CACHED_FILE_PAGES) {
    const oldest = cache.keys().next().value as number | undefined;
    if (oldest === undefined) return;
    cache.delete(oldest);
  }
}

function fileWindowLabel(data: Loaded): string {
  if (data.page === 1 && !data.hasNextPage) return `${data.files} file${data.files === 1 ? '' : 's'}`;
  return `${data.files} file${data.files === 1 ? '' : 's'} on page ${data.page}`;
}

function fileRangeLabel(data: Loaded): string {
  const first = (data.page - 1) * data.pageSize + 1;
  const last = first + data.files - 1;
  return `Showing files ${first}–${last} · page ${data.page}`;
}

function describeLoadError(err: unknown): string {
  const message = err instanceof Error ? err.message : 'Changed files could not be loaded.';
  const retryAfter = (err as { retryAfter?: unknown } | null)?.retryAfter;
  if (typeof retryAfter !== 'number' || !Number.isFinite(retryAfter) || retryAfter <= 0) return message;
  if (retryAfter < 60) return `${message} Try again in about ${Math.ceil(retryAfter)} seconds.`;
  return `${message} Try again in about ${Math.ceil(retryAfter / 60)} minutes.`;
}
