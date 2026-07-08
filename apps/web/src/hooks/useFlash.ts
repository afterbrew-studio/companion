import { useEffect, useState } from 'react';

/**
 * A transient status message that clears itself after `timeoutMs`. One concern,
 * one piece of state — reused anywhere a page flashes "done" after an action.
 */
export function useFlash(timeoutMs = 4000): { flash: string | null; show: (message: string | null) => void } {
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), timeoutMs);
    return () => clearTimeout(t);
  }, [flash, timeoutMs]);
  return { flash, show: setFlash };
}
