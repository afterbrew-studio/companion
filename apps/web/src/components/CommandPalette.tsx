import { useEffect, useMemo, useRef, useState } from 'react';
import type { IssueListRecord, PrListRecord, RepoRecord } from '@companion/module-code/contract';
import type { RunListRecord } from '@companion/module-operate/contract';
import { SearchIcon } from '@moxxy/companion-ui';
import { canUseQuickAction, runQuickAction, useKernel } from '@moxxy/companion-core/client';
import { useAuth } from '@companion/module-core/client';
import { useWorkspace } from '@companion/module-workspace/client';
import { codeApi } from '@companion/module-code/client';
import { operateApi } from '@companion/module-operate/client';

/**
 * Cmd/Ctrl+K palette: fuzzy-ish jump to pages, workspaces, repos, issues, PRs,
 * and agent runs. Entity data is fetched once per open (best effort — endpoints
 * the role cannot read just contribute nothing).
 */

interface Entry {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly hint?: string;
  readonly run: () => void;
}

const MAX_PER_GROUP = 6;
const MAX_PAGES = 24;
const ACTION_GROUPS = ['Create', 'Connect', 'Help'] as const;

export function CommandPalette({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { can } = useAuth();
  const kernel = useKernel();
  const { workspaces, current, setCurrent } = useWorkspace();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [issues, setIssues] = useState<IssueListRecord[]>([]);
  const [prs, setPrs] = useState<PrListRecord[]>([]);
  const [runs, setRuns] = useState<RunListRecord[]>([]);
  const [repos, setRepos] = useState<RepoRecord[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    let alive = true;
    const grab = <T,>(p: Promise<T>, set: (v: T) => void): void => {
      p.then((v) => alive && set(v)).catch(() => undefined);
    };
    if (current) {
      grab(codeApi.workspaceIssues(current.id, 'open'), (r) => setIssues(r.issues));
      grab(codeApi.workspacePrs(current.id), (r) => setPrs(r.prs.filter((p) => p.state === 'open')));
    }
    grab(operateApi.listRunsPage({ workspace: current?.id, limit: 50 }), (r) => setRuns(r.runs));
    grab(codeApi.listRepos(), (r) => setRepos(r.repos));
    return () => {
      alive = false;
    };
  }, [current]);

  const go = (hash: string): void => {
    location.hash = hash;
    onClose();
  };

  const entries = useMemo<Entry[]>(() => {
    const q = query.trim().toLowerCase();
    const match = (...hay: Array<string | number | null | undefined>): boolean =>
      !q || hay.filter(Boolean).join(' ').toLowerCase().includes(q);
    const cap = <T,>(arr: T[]): T[] => arr.slice(0, MAX_PER_GROUP);
    const sectionById = new Map(kernel.sections.map((section) => [section.id, section]));
    const actionEntries = ACTION_GROUPS.flatMap((group) =>
      cap(
        kernel.quickActions
          .filter(
            (action) =>
              action.group === group && canUseQuickAction(action, can) && match(action.label, action.keywords),
          )
          .map((action) => ({
            id: `action-${action.key}`,
            group: action.group,
            label: action.label,
            run: () => {
              runQuickAction(action);
              onClose();
            },
          })),
      ),
    );

    return [
      ...actionEntries,
      ...kernel.nav
        .filter((m) => {
          const section = sectionById.get(m.section);
          return can(m.permission) && match(m.label, section?.label, section?.placement === 'catalog' ? 'tool' : 'page');
        })
        .slice(0, MAX_PAGES)
        .map((m) => {
          const section = sectionById.get(m.section);
          const context = section?.placement === 'catalog' ? 'Tool' : section?.label;
          return {
            id: `page-${m.key}`,
            group: 'Tools & pages',
            label: m.label,
            hint: [context, m.shortcut ? `g${m.shortcut}` : null].filter(Boolean).join(' · ') || undefined,
            run: () => go(m.hash),
          };
        }),
      ...cap(
        workspaces
          .filter((w) => w.id !== current?.id && match(w.name, 'workspace'))
          .map((w) => ({
            id: `ws-${w.id}`,
            group: 'Switch workspace',
            label: w.name,
            hint: `${w.repoCount} ${w.repoCount === 1 ? 'repo' : 'repos'}`,
            run: () => {
              setCurrent(w.id);
              onClose();
            },
          })),
      ),
      ...cap(
        repos
          .filter((r) => match(r.fullName))
          .map((r) => ({
            id: `repo-${r.fullName}`,
            group: 'Repositories',
            label: r.fullName,
            hint: `${r.openIssues} open issues`,
            run: () => go('#/repos'),
          })),
      ),
      ...cap(
        issues
          .filter((i) => match(i.title, i.repo, `#${i.number}`))
          .map((i) => ({
            id: `issue-${i.repo}-${i.number}`,
            group: 'Issues',
            label: `#${i.number} ${i.title}`,
            hint: i.repo,
            run: () => go(`#/repos/${i.repo}/issues/${i.number}`),
          })),
      ),
      ...cap(
        prs
          .filter((p) => match(p.title, p.repo, `#${p.number}`))
          .map((p) => ({
            id: `pr-${p.repo}-${p.number}`,
            group: 'Pull requests',
            label: `#${p.number} ${p.title}`,
            hint: p.repo,
            run: () => go(`#/repos/${p.repo}/prs/${p.number}`),
          })),
      ),
      ...cap(
        runs
          .filter((r) => match(r.title, r.id))
          .map((r) => ({
            id: `run-${r.id}`,
            group: 'Agent runs',
            label: r.title,
            hint: r.live ? 'live' : r.status,
            run: () => go(`#/runs/${r.id}`),
          })),
      ),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, can, kernel.nav, kernel.sections, kernel.quickActions, workspaces, current, repos, issues, prs, runs]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  // Keep the active row in view while arrowing through.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, entries.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      entries[active]?.run();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  let lastGroup = '';
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Global search"
      onClick={onClose}
    >
      <div
        className="anim-in w-full max-w-lg overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2.5 border-b border-zinc-200 px-4 dark:border-zinc-800">
          <SearchIcon className="dim size-4" />
          <input
            ref={inputRef}
            type="search"
            className="flex-1 bg-transparent py-3 text-sm outline-none placeholder:text-zinc-400"
            placeholder="Search tools, actions, issues, PRs…"
            aria-label="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd className="dim rounded border border-zinc-200 px-1.5 py-0.5 font-mono text-[10px] dark:border-zinc-700">
            esc
          </kbd>
        </div>
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto p-1.5" role="listbox" aria-label="Results">
          {entries.map((entry, i) => {
            const header = entry.group !== lastGroup ? entry.group : null;
            lastGroup = entry.group;
            return (
              <div key={entry.id}>
                {header ? (
                  <div className="dim px-2.5 pt-2 pb-1 text-[10px] font-medium tracking-widest uppercase">
                    {header}
                  </div>
                ) : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  data-index={i}
                  className={`flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] ${
                    i === active ? 'bg-zinc-100 dark:bg-zinc-800' : ''
                  }`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => entry.run()}
                >
                  <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                  {entry.hint ? <span className="dim shrink-0">{entry.hint}</span> : null}
                </button>
              </div>
            );
          })}
          {entries.length === 0 ? <div className="dim px-3 py-6 text-center">No matches.</div> : null}
        </div>
      </div>
    </div>
  );
}
