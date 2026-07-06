import { useCallback, useEffect, useState } from 'react';
import type { RepoRecord } from '@companion/contract';
import { api, onServerMessage } from '../lib/api.js';
import { useWorkspace } from '../lib/workspace.js';
import { ListFooter, PAGE_SIZE, useDebounced, useInfiniteList } from '../lib/paging.js';
import { Page, AssigneeNote, CommentCount, Dropdown, EmptyState, FilterField, FiltersPopover, GitHubUser, LabelChips, PageHeader, Tabs, timeAgo } from '../components/ui.js';

type IssueTab = 'open' | 'closed';

function tabFromHash(): IssueTab {
  return new URLSearchParams(location.hash.split('?')[1] ?? '').get('state') === 'closed' ? 'closed' : 'open';
}

/**
 * Issues across every repo of the active workspace. Server-paged: only the
 * visible window is loaded; search and filters run in the database.
 */
export function IssuesAreaPage(): JSX.Element {
  const { current } = useWorkspace();
  // Tab state rides the URL (#/issues?state=closed) so back navigation works.
  const [tab, setTabState] = useState<IssueTab>(tabFromHash);
  const setTab = (t: IssueTab): void => {
    const base = location.hash.split('?')[0] || '#/issues';
    location.hash = t === 'open' ? base : `${base}?state=${t}`;
  };
  useEffect(() => {
    const onHash = (): void => setTabState(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  // Remember the tab so breadcrumbs from a detail view return to it.
  useEffect(() => {
    sessionStorage.setItem('companion.tab:#/issues', tab);
  }, [tab]);

  const [search, setSearch] = useState('');
  const [repoFilter, setRepoFilter] = useState<string>('all');
  const [authorFilter, setAuthorFilter] = useState<string>('all');
  const [assigneeFilter, setAssigneeFilter] = useState<string>('all');
  const [labelFilter, setLabelFilter] = useState<string>('all');
  const [repos, setRepos] = useState<RepoRecord[]>([]);
  const [facets, setFacets] = useState<{ authors: string[]; assignees: string[]; labels: string[] }>({
    authors: [],
    assignees: [],
    labels: [],
  });
  const [counts, setCounts] = useState<{ open: number; closed: number }>({ open: 0, closed: 0 });

  useEffect(() => {
    if (!current) return;
    api
      .workspaceRepos(current.id)
      .then(({ repos }) => setRepos(repos))
      .catch(() => setRepos([]));
  }, [current]);

  const q = useDebounced(search.trim());
  const fetchPage = useCallback(
    async (offset: number) => {
      if (!current) return { items: [], total: 0 };
      const page = await api.workspaceIssues(current.id, tab, {
        q: q || undefined,
        repo: repoFilter === 'all' ? undefined : repoFilter,
        author: authorFilter === 'all' ? undefined : authorFilter,
        assignee: assigneeFilter === 'all' ? undefined : assigneeFilter,
        label: labelFilter === 'all' ? undefined : labelFilter,
        limit: PAGE_SIZE,
        offset,
      });
      setCounts(page.counts);
      setFacets(page.facets);
      return { items: page.issues, total: page.total };
    },
    [current, tab, q, repoFilter, authorFilter, assigneeFilter, labelFilter],
  );
  const { items: issues, total, loading, hasMore, loadMore, reload, error } = useInfiniteList(fetchPage);
  const activeFilters = [repoFilter, authorFilter, assigneeFilter, labelFilter].filter((f) => f !== 'all').length;

  useEffect(() => {
    return onServerMessage((msg) => {
      if (msg.t === 'issues.changed' || msg.t === 'triage.changed') reload();
    });
  }, [reload]);

  if (!current) return <EmptyState title="No workspace selected" />;

  return (
    <Page>
      <PageHeader
        title="Issues"
        subtitle={current.name}
        actions={
          <>
            <input
              className="input w-56"
              type="search"
              placeholder="Search issues…  ( / )"
              data-shortcut="search"
              aria-label="Search issues"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <FiltersPopover
              active={activeFilters}
              onClear={() => {
                setRepoFilter('all');
                setAuthorFilter('all');
                setAssigneeFilter('all');
                setLabelFilter('all');
              }}
            >
              {repos.length > 1 ? (
                <FilterField label="Repository">
                  <Dropdown
                    ariaLabel="Filter by repository"
                    value={repoFilter}
                    onChange={setRepoFilter}
                    options={[
                      { value: 'all', label: 'All repos' },
                      ...repos.map((r) => ({ value: r.fullName, label: r.fullName.split('/')[1] ?? r.fullName })),
                    ]}
                  />
                </FilterField>
              ) : null}
              <FilterField label="Author">
                <Dropdown
                  ariaLabel="Filter by author"
                  value={authorFilter}
                  onChange={setAuthorFilter}
                  searchable={facets.authors.length > 8}
                  options={[{ value: 'all', label: 'Any author' }, ...facets.authors.map((a) => ({ value: a, label: a }))]}
                />
              </FilterField>
              <FilterField label="Assignee">
                <Dropdown
                  ariaLabel="Filter by assignee"
                  value={assigneeFilter}
                  onChange={setAssigneeFilter}
                  searchable={facets.assignees.length > 8}
                  options={[
                    { value: 'all', label: 'Any assignee' },
                    { value: '__none', label: 'Unassigned' },
                    ...facets.assignees.map((a) => ({ value: a, label: a })),
                  ]}
                />
              </FilterField>
              <FilterField label="Label">
                <Dropdown
                  ariaLabel="Filter by label"
                  value={labelFilter}
                  onChange={setLabelFilter}
                  searchable={facets.labels.length > 8}
                  options={[{ value: 'all', label: 'Any label' }, ...facets.labels.map((l) => ({ value: l, label: l }))]}
                />
              </FilterField>
            </FiltersPopover>
          </>
        }
      />
      {error ? <div className="error-bar">{error}</div> : null}

      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { value: 'open', label: 'Open', count: counts.open },
          { value: 'closed', label: 'Closed', count: counts.closed },
        ]}
      />

      {issues.length === 0 && !loading ? (
        <EmptyState
          title={q || repoFilter !== 'all' ? 'No issues match the filters' : `No ${tab} issues`}
          hint={!q && repoFilter === 'all' ? 'Connect repositories to this workspace to start syncing issues.' : undefined}
        />
      ) : (
        <div className="card mt-3 divide-y divide-zinc-200 p-0 dark:divide-zinc-800" aria-label="Issue list">
          {issues.map((issue) => (
            <a key={`${issue.repo}#${issue.number}`} className="row-link" href={`#/repos/${issue.repo}/issues/${issue.number}`}>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="truncate font-medium">{issue.title}</span>
                  {issue.triage ? (
                    <span className={`shrink-0 ${issue.triage === 'applied' ? 'badge-ok' : 'badge-warn'}`}>
                      triage {issue.triage}
                    </span>
                  ) : null}
                </span>
                <span className="dim mt-0.5 flex items-center gap-1.5 text-xs">
                  <span className="min-w-0 truncate">
                    {repos.length > 1 ? `${issue.repo.split('/')[1]} · ` : ''}#{issue.number} ·{' '}
                    <GitHubUser login={issue.author} />
                  </span>
                  <AssigneeNote assignees={issue.assignees} />
                  <LabelChips labels={issue.labels} />
                </span>
              </span>
              <CommentCount count={issue.comments} />
              <span className="dim w-16 shrink-0 text-right" title={new Date(issue.updatedAt).toLocaleString()}>
                {timeAgo(issue.updatedAt)}
              </span>
            </a>
          ))}
          <ListFooter
            loading={loading}
            hasMore={hasMore}
            shown={issues.length}
            total={total}
            noun="issues"
            onVisible={loadMore}
          />
        </div>
      )}
    </Page>
  );
}
