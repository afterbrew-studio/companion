import { useEffect, useState } from 'react';
import { DiffView } from '../../components/DiffView.js';
import { ChevronDown, Spinner } from '../../components/ui.js';

/**
 * The PR's diff, loaded lazily. `fetchDiff` must be stable (memoize at the call
 * site) so the fetch runs once. In the review view the diff is supporting
 * material, so it starts collapsed behind a disclosure.
 */
export function PrChanges({
  fetchDiff,
  collapsible = false,
}: {
  fetchDiff: () => Promise<string>;
  collapsible?: boolean;
}): JSX.Element {
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(!collapsible);

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

  const body =
    error ? (
      <div className="banner-warn mt-2.5">Couldn't load the diff for this pull request.</div>
    ) : diff === null ? (
      <div className="dim mt-2.5 flex items-center gap-2 py-4 text-sm">
        <Spinner /> Loading the diff…
      </div>
    ) : diff.trim() ? (
      <div className="mt-2.5">
        <DiffView diff={diff} />
      </div>
    ) : (
      <div className="banner-warn mt-2.5">No file changes in this pull request.</div>
    );

  return (
    <section className="card" aria-label="Changed files">
      {collapsible ? (
        <button
          type="button"
          className="flex w-full cursor-pointer items-center gap-2 text-left"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <strong className="text-sm">Changed files</strong>
          <span className="flex-1" />
          <ChevronDown open={open} className="dim size-4 shrink-0" />
        </button>
      ) : (
        <strong className="text-sm">Changed files</strong>
      )}
      {open ? body : null}
    </section>
  );
}
