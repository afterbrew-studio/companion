import type { SpaServerMessage } from '@companion/contracts';

/**
 * A module's veto on nav "new activity" marking. The shell decides WHICH entry
 * lights up (via `NavEntry.freshOn`); a filter decides whether a message counts
 * at all. It exists for scoping the shell cannot do: `code` drops issue and PR
 * activity for repositories outside the workspace you are looking at, which
 * needs that module's own repo list.
 *
 * Registered from an effect component contributed to the `shell.effects` slot,
 * so registration follows the module's own lifecycle and the shell stays free of
 * module imports.
 */
export type FreshFilter = (msg: SpaServerMessage) => boolean;

const filters = new Set<FreshFilter>();

export function registerFreshFilter(filter: FreshFilter): () => void {
  filters.add(filter);
  return () => void filters.delete(filter);
}

/** A message marks freshness only when every registered filter accepts it. */
export function passesFreshFilters(msg: SpaServerMessage): boolean {
  for (const f of filters) if (!f(msg)) return false;
  return true;
}
