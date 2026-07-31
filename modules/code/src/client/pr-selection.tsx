import { createContext, useContext, type ReactNode } from 'react';
import type { PrRecord } from '../contract/index.js';

interface PrSelection {
  readonly selected: readonly PrRecord[];
  /** Drop the selection once an action has consumed it. */
  readonly clear: () => void;
  readonly busy: boolean;
}

const Ctx = createContext<PrSelection | null>(null);

/**
 * The PR list's current selection, published for other modules' bulk actions.
 *
 * Slots render without props, and a bulk action is useless without knowing what
 * is ticked. A context solves it in the one direction the module graph allows:
 * anything contributing to code's pages already depends on code, so it can
 * import this, while code still imports nothing of theirs.
 */
export function PrSelectionProvider({
  value,
  children,
}: {
  value: PrSelection;
  children: ReactNode;
}): JSX.Element {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Null outside the PR list, which is what a contributed button should check. */
export function usePrSelection(): PrSelection | null {
  return useContext(Ctx);
}
