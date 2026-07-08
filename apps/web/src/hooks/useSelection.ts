import { useEffect, useState } from 'react';

export interface Selection {
  readonly selected: ReadonlySet<string>;
  readonly size: number;
  readonly has: (key: string) => boolean;
  readonly toggle: (key: string) => void;
  readonly selectAll: (keys: string[]) => void;
  readonly clear: () => void;
}

/**
 * A set of selected keys for bulk actions. One concern, one piece of state.
 * Pass `resetKey` (e.g. the tab or workspace id) to clear the selection when it
 * changes. Reused by every list with checkbox multi-select.
 */
export function useSelection(resetKey?: unknown): Selection {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    setSelected(new Set());
  }, [resetKey]);
  return {
    selected,
    size: selected.size,
    has: (key) => selected.has(key),
    toggle: (key) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    selectAll: (keys) => setSelected(new Set(keys)),
    clear: () => setSelected(new Set()),
  };
}
