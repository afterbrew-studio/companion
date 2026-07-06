import { useEffect, useState } from 'react';
import { RunsPage } from './pages/RunsPage.js';
import { RunDetail } from './pages/RunDetail.js';
import { ReposPage } from './pages/ReposPage.js';
import { IssuesPage } from './pages/IssuesPage.js';
import { IssueDetail } from './pages/IssueDetail.js';
import { PrDetail } from './pages/PrDetail.js';
import { ProposalsPage } from './pages/Proposals.js';
import { AutomationsPage } from './pages/Automations.js';
import { SettingsPage } from './pages/Settings.js';

function useHashRoute(): string {
  const [hash, setHash] = useState(location.hash || '#/repos');
  useEffect(() => {
    const onChange = (): void => setHash(location.hash || '#/repos');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

const NAV = [
  ['#/repos', 'Repos'],
  ['#/proposals', 'Proposals'],
  ['#/runs', 'Runs'],
  ['#/automations', 'Automations'],
  ['#/settings', 'Settings'],
] as const;

export function App(): JSX.Element {
  const hash = useHashRoute();
  return (
    <div className="flex h-full">
      <aside className="flex w-48 flex-col gap-5 border-r border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="px-2 text-base font-bold">Companion</div>
        <nav className="flex flex-col gap-0.5">
          {NAV.map(([href, label]) => (
            <a
              key={href}
              href={href}
              className={`rounded-lg px-2.5 py-1.5 text-sm ${
                hash.startsWith(href)
                  ? 'bg-indigo-600 text-white dark:bg-indigo-500 dark:text-zinc-950'
                  : 'text-zinc-700 hover:bg-zinc-200 dark:text-zinc-300 dark:hover:bg-zinc-800'
              }`}
            >
              {label}
            </a>
          ))}
        </nav>
      </aside>
      <main className="h-full flex-1 overflow-y-auto">
        <Route hash={hash} />
      </main>
    </div>
  );
}

function Route({ hash }: { hash: string }): JSX.Element {
  let m = hash.match(/^#\/runs\/([A-Za-z0-9_-]+)$/);
  if (m) return <RunDetail key={m[1]} runId={m[1]!} />;
  m = hash.match(/^#\/repos\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)$/);
  if (m) return <IssueDetail key={hash} repo={`${m[1]}/${m[2]}`} number={Number(m[3])} />;
  m = hash.match(/^#\/repos\/([\w.-]+)\/([\w.-]+)\/prs\/(\d+)$/);
  if (m) return <PrDetail key={hash} repo={`${m[1]}/${m[2]}`} number={Number(m[3])} />;
  m = hash.match(/^#\/repos\/([\w.-]+)\/([\w.-]+)$/);
  if (m) return <IssuesPage key={hash} repo={`${m[1]}/${m[2]}`} />;
  if (hash.startsWith('#/runs')) return <RunsPage />;
  if (hash.startsWith('#/proposals')) return <ProposalsPage />;
  if (hash.startsWith('#/automations')) return <AutomationsPage />;
  if (hash.startsWith('#/settings')) return <SettingsPage />;
  return <ReposPage />;
}
