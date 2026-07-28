import { useEffect, useRef } from 'react';
import type { SpaServerMessage } from '@moxxy/companion-contracts';
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

/**
 * React to a message owned by a module you do NOT depend on. The tag is absent
 * from this compilation's `SpaServerMessage` union, because the union only
 * contains the contracts this module imports, so it cannot be compared directly.
 *
 * This is the client-side twin of `ctx.services.tryGet` on the server: a soft,
 * one-way reaction that degrades to "never fires" when the owning module is
 * absent. Use it only for a refresh or a badge, never to gate behaviour, and
 * never as a way around declaring a real `dependsOn`.
 */
export const isMessage = (msg: { readonly t: string }, tag: string): boolean => msg.t === tag;
