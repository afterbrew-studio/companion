import {
  BrandTile,
  Dropdown,
  PlusIcon,
  SearchIcon,
  Spinner,
  StatusDot,
  UserIcon,
} from '@moxxy/companion-sdk/ui';
import type { IssueListRecord, PrListRecord } from '@companion/module-code/contract';
import { useAuth } from '@companion/module-core/client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DeskContextRef } from '../../contract/index.js';

export type DeskSection = 'overview' | 'missions' | 'activity';

interface DeskHeaderProps {
  readonly section: DeskSection;
  readonly missionCount: number;
  readonly activityCount: number;
  readonly prs: readonly PrListRecord[];
  readonly issues: readonly IssueListRecord[];
  readonly searchLoading: boolean;
  readonly searchError: string | null;
  readonly searchScope: string;
  readonly onOpenContext: (context: DeskContextRef) => void;
  readonly onNavigate: (section: DeskSection) => void;
  readonly onNewMission: () => void;
  readonly creating: boolean;
  readonly canCreate: boolean;
}

export function DeskHeader({
  section,
  missionCount,
  activityCount,
  prs,
  issues,
  searchLoading,
  searchError,
  searchScope,
  onOpenContext,
  onNavigate,
  onNewMission,
  creating,
  canCreate,
}: DeskHeaderProps): React.JSX.Element {
  const auth = useAuth();
  const modalSearchRef = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');

  const openSearch = (): void => {
    setSearchOpen(true);
    requestAnimationFrame(() => modalSearchRef.current?.focus());
  };

  const closeSearch = (): void => {
    setSearchOpen(false);
    setQuery('');
  };

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openSearch();
      } else if (!event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'n' && !isTextEntry(event.target)) {
        event.preventDefault();
        if (canCreate && !creating) onNewMission();
      } else if (event.key === 'Escape') {
        setSearchOpen(false);
        setQuery('');
      }
    };
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, [canCreate, creating, onNewMission]);

  const accountOptions = [
    { value: 'companion', label: 'Open full Companion' },
    { value: 'sign-out', label: 'Sign out', hint: auth.user?.username },
  ] as const;

  return (
    <header className="flex h-14 shrink-0 items-stretch border-b border-zinc-200 bg-white px-5 dark:border-zinc-800 dark:bg-zinc-950">
      <button
        type="button"
        className="mr-8 flex shrink-0 cursor-pointer items-center gap-2"
        onClick={() => onNavigate('overview')}
        aria-label="Companion Desk overview"
      >
        {auth.branding.logo ? (
          <img src={auth.branding.logo} alt="" className="size-7 rounded-lg object-cover" />
        ) : (
          <BrandTile />
        )}
        <span className="text-sm font-semibold">Desk</span>
      </button>

      <nav className="flex items-stretch gap-6" aria-label="Desk">
        <HeaderTab active={section === 'overview'} onClick={() => onNavigate('overview')}>Overview</HeaderTab>
        <HeaderTab active={section === 'missions'} onClick={() => onNavigate('missions')}>
          Missions
          {missionCount > 0 ? (
            <span className="rounded-md bg-zinc-100 px-1.5 py-0.5 text-[10px] tabular-nums dark:bg-zinc-800">
              {missionCount}
            </span>
          ) : null}
        </HeaderTab>
        <HeaderTab active={section === 'activity'} onClick={() => onNavigate('activity')}>
          Activity
          {activityCount > 0 ? (
            <span className="rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700 tabular-nums dark:bg-amber-950/40 dark:text-amber-300">
              {activityCount}
            </span>
          ) : null}
        </HeaderTab>
      </nav>

      <div className="flex-1" />
      <button
        type="button"
        className="relative my-auto mr-3 hidden h-8 w-64 min-w-0 cursor-text items-center overflow-hidden rounded-lg border border-zinc-200 bg-white pr-11 pl-9 text-left text-xs text-zinc-400 transition-colors hover:border-zinc-300 lg:flex dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
        onClick={openSearch}
        aria-haspopup="dialog"
        aria-expanded={searchOpen}
      >
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-zinc-400" />
        <span className="min-w-0 flex-1 truncate whitespace-nowrap">Search pull requests and issues…</span>
        <kbd className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 rounded border border-zinc-200 px-1 text-[9px] text-zinc-400 dark:border-zinc-700">⌘K</kbd>
      </button>
      <button
        type="button"
        className="btn my-auto h-8 shrink-0 px-3 text-xs"
        disabled={!canCreate || creating}
        onClick={onNewMission}
        aria-keyshortcuts="N"
        title="New mission (N)"
      >
        {creating ? <Spinner /> : <PlusIcon className="size-3.5" />}
        New mission
        <kbd className="ml-1 rounded border border-white/20 px-1 py-0.5 text-[8px] font-normal opacity-60 dark:border-zinc-700">N</kbd>
      </button>
      <Dropdown
        value={null}
        onChange={(value) => {
          if (value === 'companion') location.href = '/';
          else void auth.logout();
        }}
        options={accountOptions}
        ariaLabel="Account"
        className="my-auto ml-3"
        triggerClassName="dim flex size-8 cursor-pointer items-center justify-center rounded-lg transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
        renderTrigger={() => <UserIcon className="size-4.5" />}
      />
      {searchOpen ? (
        <QuickSearch
          query={query}
          onQuery={setQuery}
          prs={prs}
          issues={issues}
          loading={searchLoading}
          error={searchError}
          scope={searchScope}
          inputRef={modalSearchRef}
          onClose={closeSearch}
          onOpen={(context) => {
            closeSearch();
            onOpenContext(context);
          }}
        />
      ) : null}
    </header>
  );
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.matches('input, textarea, select');
}

interface SearchItem {
  readonly context: DeskContextRef;
  readonly title: string;
  readonly updatedAt: number;
}

function QuickSearch({
  query,
  onQuery,
  prs,
  issues,
  loading,
  error,
  scope,
  inputRef,
  onClose,
  onOpen,
}: {
  readonly query: string;
  readonly onQuery: (value: string) => void;
  readonly prs: readonly PrListRecord[];
  readonly issues: readonly IssueListRecord[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly scope: string;
  readonly inputRef: React.RefObject<HTMLInputElement | null>;
  readonly onClose: () => void;
  readonly onOpen: (context: DeskContextRef) => void;
}): React.JSX.Element {
  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return [
      ...prs.map((pr): SearchItem => ({
        context: { kind: 'pull-request', repo: pr.repo, number: pr.number },
        title: pr.title,
        updatedAt: pr.updatedAt,
      })),
      ...issues.map((issue): SearchItem => ({
        context: { kind: 'issue', repo: issue.repo, number: issue.number },
        title: issue.title,
        updatedAt: issue.updatedAt,
      })),
    ]
      .filter((item) => !needle || `${item.context.repo} ${item.context.number} ${item.title} ${item.context.kind}`.toLowerCase().includes(needle))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 20);
  }, [issues, prs, query]);

  return (
    <div
      className="fixed inset-0 z-50 bg-zinc-950/25 px-4 pt-[12vh] backdrop-blur-[1px]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="mx-auto flex max-h-[70vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950"
        role="dialog"
        aria-modal="true"
        aria-label="Search pull requests and issues"
      >
        <label className="relative block shrink-0 border-b border-zinc-200 dark:border-zinc-800">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-5 size-4 -translate-y-1/2 text-zinc-400" />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && results[0]) onOpen(results[0].context);
            }}
            className="h-14 w-full bg-transparent pr-16 pl-12 text-sm outline-none placeholder:text-zinc-400"
            placeholder="Search by title, number, or repository…"
            aria-label="Search pull requests and issues"
          />
          <kbd className="pointer-events-none absolute top-1/2 right-5 -translate-y-1/2 rounded border border-zinc-200 px-1.5 py-0.5 text-[9px] text-zinc-400 dark:border-zinc-700">esc</kbd>
        </label>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="dim flex shrink-0 items-center justify-between border-b border-zinc-100 px-5 py-2 text-[10px] dark:border-zinc-900">
            <span>{scope}</span>
            <span>{results.length === 20 ? '20 most relevant' : `${results.length} results`}</span>
          </div>
          <div className="min-h-0 overflow-y-auto p-2">
            {loading && prs.length === 0 && issues.length === 0 ? (
              <div className="dim flex items-center justify-center gap-2 px-5 py-12 text-xs"><Spinner /> Loading GitHub items…</div>
            ) : error ? (
              <p className="px-5 py-12 text-center text-xs text-red-600 dark:text-red-400">{error}</p>
            ) : results.length === 0 ? (
              <p className="dim px-5 py-12 text-center text-xs">No matching pull requests or issues.</p>
            ) : results.map((item) => (
              <button
                key={`${item.context.kind}:${item.context.repo}#${item.context.number}`}
                type="button"
                className="group flex w-full cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-900"
                onClick={() => onOpen(item.context)}
              >
                <StatusDot tone={item.context.kind === 'pull-request' ? 'green' : 'zinc'} size="sm" className="mt-1.5" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium group-hover:text-zinc-950 dark:group-hover:text-zinc-50">{item.title}</span>
                  <span className="dim mt-0.5 block truncate text-[10px]">
                    {item.context.kind === 'pull-request' ? 'Pull request' : 'Issue'} #{item.context.number} · {item.context.repo}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function HeaderTab({
  active,
  onClick,
  children,
}: {
  readonly active: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`relative flex cursor-pointer items-center gap-1.5 text-xs font-medium transition-colors ${
        active ? 'text-zinc-950 dark:text-zinc-50' : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
      }`}
      onClick={onClick}
    >
      {children}
      {active ? <span className="absolute right-0 bottom-0 left-0 h-0.5 bg-zinc-950 dark:bg-zinc-50" /> : null}
    </button>
  );
}
