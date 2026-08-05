import type { ReactNode } from 'react';
import { SearchInput } from '@moxxy/companion-sdk/ui';

/** One calm control row shared by Specifications and Documentation. */
export function KnowledgeToolbar({
  search,
  onSearch,
  ariaLabel,
  leading,
  children,
}: {
  readonly search: string;
  readonly onSearch: (value: string) => void;
  readonly ariaLabel: string;
  readonly leading?: ReactNode;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="mb-4 flex flex-col gap-2 rounded-xl border border-zinc-200 bg-zinc-50/70 p-2 sm:flex-row sm:items-center dark:border-zinc-800 dark:bg-zinc-900/50">
      {leading ? <div className="shrink-0">{leading}</div> : null}
      <div className="flex min-w-0 flex-1 items-center gap-2 sm:justify-end">
        <SearchInput
          value={search}
          onChange={onSearch}
          placeholder="Search title or content…  ( / )"
          ariaLabel={ariaLabel}
          className="min-w-0 flex-1 sm:max-w-sm"
        />
        {children}
      </div>
    </div>
  );
}
