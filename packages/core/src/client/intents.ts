import { useEffect, useRef } from 'react';

/**
 * One-shot UI intents: let a component (the command palette) ask another
 * component (a page, the sidebar) to open a modal — even one it doesn't own
 * and that may not be mounted yet.
 *
 * `requestIntent` navigates to the owning page first (if given a hash) and
 * parks the intent; whichever `useIntent(name)` mounts next consumes it once.
 * When the target is already mounted (the always-present workspace switcher),
 * listeners fire synchronously and it opens immediately.
 */

export type Intent = 'new-workspace' | 'connect-repo' | 'connect-github';

/** The page that owns each intent's modal (undefined = handled anywhere, e.g. the sidebar). */
export const INTENT_HASH: Record<Intent, string | undefined> = {
  'new-workspace': undefined,
  'connect-repo': '#/repos',
  'connect-github': '#/github',
};

/** Fire an intent, navigating to its owning page automatically. */
export function runIntent(intent: Intent): void {
  requestIntent(intent, INTENT_HASH[intent]);
}

let pending: Intent | null = null;
const listeners = new Set<() => void>();

/** Ask for `intent`, first navigating to `hash` if we're not already there. */
export function requestIntent(intent: Intent, hash?: string): void {
  pending = intent;
  if (hash) {
    const base = location.hash.split('?')[0];
    if (base !== hash) {
      // The destination page consumes `pending` from its mount effect.
      location.hash = hash;
      return;
    }
  }
  for (const notify of [...listeners]) notify();
}

/** Run `handler` once whenever `intent` is requested — now or on a later mount. */
export function useIntent(intent: Intent, handler: () => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const consume = (): void => {
      if (pending !== intent) return;
      pending = null;
      ref.current();
    };
    listeners.add(consume);
    // Catch an intent parked just before this page mounted (post-navigation).
    consume();
    return () => {
      listeners.delete(consume);
    };
  }, [intent]);
}
