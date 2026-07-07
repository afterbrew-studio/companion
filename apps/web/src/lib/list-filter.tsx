import { useCallback, useState } from 'react';
import { FilterField, FiltersPopover } from '../components/ui.js';

/**
 * Shared list filtering: the search box + N select filters, active counting,
 * clearing, and the "X of Y" readout that every list page (Runs, Specs, Docs,
 * Proposals) previously hand-rolled. One `useListFilter` per page, field
 * definitions as data, `ListFilterToolbar` for the chrome.
 */

export interface FilterSelectField<T> {
  readonly key: string;
  readonly label: string;
  /** Shown for the neutral '' option, e.g. "All repositories". */
  readonly allLabel: string;
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  /** Applied only when a non-empty value is selected. */
  readonly match: (item: T, value: string) => boolean;
}

export interface ListFilterState<T> {
  readonly q: string;
  readonly setQ: (q: string) => void;
  readonly values: Readonly<Record<string, string>>;
  readonly set: (key: string, value: string) => void;
  readonly clear: () => void;
  readonly active: number;
  readonly filtered: T[];
}

export function useListFilter<T>(
  items: readonly T[],
  search: (item: T, needle: string) => boolean,
  fields: ReadonlyArray<FilterSelectField<T>>,
): ListFilterState<T> {
  const [q, setQ] = useState('');
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const set = useCallback(
    (key: string, value: string) => setValues((prev) => ({ ...prev, [key]: value })),
    [],
  );
  const clear = useCallback(() => setValues({}), []);
  const active = fields.reduce((n, f) => n + (values[f.key] ? 1 : 0), 0);
  const needle = q.trim().toLowerCase();
  // Lists here are a few hundred rows at most — filtering per render is
  // cheaper than pinning every match callback for a useMemo.
  const filtered = items.filter((item) => {
    for (const f of fields) {
      const value = values[f.key];
      if (value && !f.match(item, value)) return false;
    }
    return !needle || search(item, needle);
  });
  return { q, setQ, values, set, clear, active, filtered };
}

/** `facet(items, (i) => i.repo)` → sorted unique non-empty values. */
export function facet<T>(items: readonly T[], pick: (item: T) => string | null | undefined): string[] {
  return [...new Set(items.map(pick).filter((v): v is string => Boolean(v)))].sort();
}

/** The standard toolbar row: search, funnel popover, "X of Y" when narrowed. */
export function ListFilterToolbar<T>({
  filter,
  fields,
  total,
  placeholder,
  searchLabel,
}: {
  filter: ListFilterState<T>;
  fields: ReadonlyArray<FilterSelectField<T>>;
  total: number;
  placeholder: string;
  searchLabel: string;
}): JSX.Element {
  return (
    <div className="mb-3 flex items-center gap-2">
      <input
        className="input w-full max-w-xs"
        value={filter.q}
        onChange={(e) => filter.setQ(e.target.value)}
        placeholder={placeholder}
        aria-label={searchLabel}
      />
      <FiltersPopover active={filter.active} onClear={filter.clear}>
        {fields.map((f) => (
          <FilterField key={f.key} label={f.label}>
            <select className="input" value={filter.values[f.key] ?? ''} onChange={(e) => filter.set(f.key, e.target.value)}>
              <option value="">{f.allLabel}</option>
              {f.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </FilterField>
        ))}
      </FiltersPopover>
      {filter.filtered.length !== total ? (
        <span className="dim ml-auto shrink-0 text-xs">
          {filter.filtered.length} of {total}
        </span>
      ) : null}
    </div>
  );
}
