import { useEffect, useState } from 'react';
import { DiffView } from '../../components/DiffView.js';
import { ChevronDown, Spinner } from '../../components/ui.js';

/**
 * The PR's diff, loaded lazily and collapsed by default: the header shows the
 * files-changed count and the added/removed line totals, and expands to the
 * full diff on click. `fetchDiff` must be stable (memoize at the call site) so
 * the fetch runs once.
 */
export function PrChanges({ fetchDiff }: { fetchDiff: () => Promise<string> }): JSX.Element {
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    setDiff(null);
    setError(false);
    fetchDiff()
      .then((d) => alive && setDiff(d))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [fetchDiff]);

  const stat = diff ? diffStat(diff) : null;
  const hasChanges = !!stat && stat.files > 0;

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
        {diff === null && !error ? (
          <span className="dim flex items-center gap-1.5">
            <Spinner /> loading…
          </span>
        ) : null}
        {error ? <span className="badge-danger">unavailable</span> : null}
        {stat && stat.files > 0 ? (
          <span className="flex items-center gap-2.5 text-xs">
            <span className="dim tabular-nums">
              {stat.files} file{stat.files === 1 ? '' : 's'}
            </span>
            <span className="font-medium text-emerald-600 tabular-nums dark:text-emerald-400">+{stat.added}</span>
            <span className="font-medium text-red-600 tabular-nums dark:text-red-400">−{stat.removed}</span>
          </span>
        ) : null}
        {stat && stat.files === 0 ? <span className="dim">no file changes</span> : null}
        <span className="flex-1" />
        {hasChanges ? <ChevronDown open={open} className="dim size-4 shrink-0" /> : null}
      </button>

      {open && diff && diff.trim() ? (
        <div className="mt-3">
          <DiffView diff={diff} />
        </div>
      ) : null}
    </section>
  );
}

function diffStat(diff: string): { files: number; added: number; removed: number } {
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) files++;
    else if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { files, added, removed };
}
