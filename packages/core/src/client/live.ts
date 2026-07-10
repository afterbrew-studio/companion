import { useEffect, useRef } from 'react';
import type { SpaServerMessage } from '@companion/contracts';
import { onServerMessage } from './net.js';

/**
 * The standard page data loop, extracted: load now, reload whenever a matching
 * WS message arrives. `when` is read through a ref so an inline closure never
 * causes resubscription — only a changed `refresh` (usually useCallback'd on
 * the active workspace) re-runs the effect.
 */
export function useLive(
  refresh: () => void | Promise<void>,
  when: (msg: SpaServerMessage) => boolean,
): void {
  const whenRef = useRef(when);
  whenRef.current = when;
  useEffect(() => {
    void refresh();
    return onServerMessage((msg) => {
      if (whenRef.current(msg)) void refresh();
    });
  }, [refresh]);
}
