import { useEffect, useState } from 'react';
import { useHashParams } from '../lib/hashParams.js';
import { useDebounced } from '../lib/paging.js';

/**
 * A search box whose debounced value is mirrored into the ?q= hash param
 * (replace, so keystrokes don't pile up in history) and re-hydrated from the URL
 * on back/forward. One own piece of state (the raw input); `q` is the debounced
 * value to query on.
 */
export function useHashSearch(): { search: string; setSearch: (s: string) => void; q: string } {
  const [params, setParam] = useHashParams();
  const [search, setSearch] = useState(() => params.get('q') ?? '');
  useEffect(() => {
    const urlQ = params.get('q') ?? '';
    setSearch((s) => (s.trim() === urlQ ? s : urlQ));
  }, [params]);
  const q = useDebounced(search.trim());
  useEffect(() => {
    setParam('q', q || null, { replace: true });
  }, [q, setParam]);
  return { search, setSearch, q };
}
