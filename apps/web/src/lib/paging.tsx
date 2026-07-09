import { useCallback, useEffect, useRef, useState } from 'react';
import { Spinner } from '../components/ui.js';

/** Debounce fast-changing input (search boxes) before it hits the server. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

export const PAGE_SIZE = 50;

interface InfiniteState<T> {
  readonly items: T[];
  readonly total: number;
  readonly loading: boolean;
  readonly error: string | null;
}

/**
 * Server-driven infinite list: loads the first window whenever `fetchPage`'s
 * identity changes (memoize it on your filters), appends on demand, and
 * guards against out-of-order responses.
 */
export function useInfiniteList<T>(fetchPage: (offset: number) => Promise<{ items: T[]; total: number }>): {
  items: T[];
  total: number;
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
  reload: () => void;
} {
  const [state, setState] = useState<InfiniteState<T>>({ items: [], total: 0, loading: true, error: null });
  const seq = useRef(0);

  const load = useCallback(
    (offset: number) => {
      const mySeq = ++seq.current;
      // Only show the loading state when there's nothing to show yet (first load
      // or a page append). A background reload (offset 0 with rows already on
      // screen — e.g. a prs.changed refresh) keeps the current rows so the list
      // doesn't flash/flicker; they swap in place when the new data arrives.
      setState((prev) => ({
        ...prev,
        loading: offset === 0 ? prev.items.length === 0 : true,
        error: null,
      }));
      fetchPage(offset)
        .then(({ items, total }) => {
          if (seq.current !== mySeq) return;
          setState((prev) => ({
            items: offset === 0 ? items : [...prev.items, ...items],
            total,
            loading: false,
            error: null,
          }));
        })
        .catch((err: unknown) => {
          if (seq.current !== mySeq) return;
          setState((prev) => ({ ...prev, loading: false, error: String(err) }));
        });
    },
    [fetchPage],
  );

  useEffect(() => {
    load(0);
  }, [load]);

  const loadMore = useCallback(() => {
    setState((prev) => {
      if (!prev.loading && prev.items.length < prev.total) load(prev.items.length);
      return prev;
    });
  }, [load]);

  return {
    ...state,
    hasMore: state.items.length < state.total,
    loadMore,
    reload: () => load(0),
  };
}

/**
 * Invisible scroll sentinel + footer status: triggers `onVisible` when it
 * scrolls near the viewport, shows the loaded/total tally, and a spinner while
 * a window is in flight.
 */
export function ListFooter({
  loading,
  hasMore,
  shown,
  total,
  noun,
  onVisible,
}: {
  loading: boolean;
  hasMore: boolean;
  shown: number;
  total: number;
  noun: string;
  onVisible: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onVisible();
      },
      { rootMargin: '400px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, onVisible]);

  return (
    <div ref={ref} className="dim flex items-center justify-center gap-2 py-3" role="status">
      {loading ? (
        <>
          <Spinner /> Loading…
        </>
      ) : total > 0 ? (
        `${shown} of ${total} ${noun}`
      ) : null}
    </div>
  );
}
