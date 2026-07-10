import { useCallback, useEffect, useState } from 'react';

function parse(): URLSearchParams {
  return new URLSearchParams(location.hash.split('?')[1] ?? '');
}

/**
 * Filter/tab state that lives in the hash query (#/issues?state=closed&author=__me)
 * so any filtered view is a shareable, back-button-friendly URL.
 */
export function useHashParams(): [
  URLSearchParams,
  (key: string, value: string | null, opts?: { replace?: boolean }) => void,
] {
  const [params, setParams] = useState<URLSearchParams>(parse);

  useEffect(() => {
    const onHash = (): void => setParams(parse());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const setParam = useCallback((key: string, value: string | null, opts?: { replace?: boolean }) => {
    const [base, qs] = location.hash.split('?');
    const next = new URLSearchParams(qs ?? '');
    if (value === null || value === '') next.delete(key);
    else next.set(key, value);
    const query = next.toString();
    const target = query ? `${base}?${query}` : (base ?? '');
    if (target === location.hash) return;
    if (opts?.replace) {
      // Search keystrokes shouldn't pile up in browser history; replaceState
      // fires no hashchange, so mirror the params into state ourselves.
      history.replaceState(null, '', target);
      setParams(next);
    } else {
      location.hash = target;
    }
  }, []);

  return [params, setParam];
}
