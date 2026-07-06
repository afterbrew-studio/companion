import { useCallback, useEffect, useState } from 'react';
import type { ReportRecord, RepoRecord, WebhookInfo } from '@companion/contract';
import { api, onServerMessage } from '../lib/api.js';
import { useWorkspace } from '../lib/workspace.js';
import { Markdown } from '../components/Markdown.js';
import { Page, CopyText, EmptyState, PageHeader, Section, Switch, timeAgo } from '../components/ui.js';

/** Per-repo automation switches + the report feed they produce, workspace-scoped. */
export function AutomationsPage(): JSX.Element {
  const { current } = useWorkspace();
  const [repos, setRepos] = useState<RepoRecord[]>([]);
  const [reports, setReports] = useState<ReportRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!current) return;
    try {
      const [r, rep] = await Promise.all([api.workspaceRepos(current.id), api.listReports()]);
      setRepos(r.repos);
      setReports(rep.reports);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [current]);

  useEffect(() => {
    void refresh();
    return onServerMessage((msg) => {
      if (msg.t === 'repos.changed' || msg.t === 'reports.changed' || msg.t === 'workspaces.changed') void refresh();
    });
  }, [refresh]);

  if (!current) {
    return (
      <Page>
        <EmptyState title="No workspace yet" hint="Create a workspace from the sidebar switcher first." />
      </Page>
    );
  }

  const repoNames = new Set(repos.map((r) => r.fullName));
  const workspaceReports = reports.filter((r) => r.repo === null || repoNames.has(r.repo));

  return (
    <Page>
      <PageHeader
        title="Automations"
        subtitle={`${current.name} — webhook receivers and scheduled agents, per repository`}
      />
      {error ? <div className="error-bar">{error}</div> : null}

      <div className="flex flex-col gap-3">
        {repos.map((repo) => (
          <RepoAutomation key={repo.fullName} repo={repo} onChange={refresh} onError={setError} />
        ))}
      </div>
      {repos.length === 0 ? (
        <EmptyState
          title="No repositories in this workspace"
          hint="Connect a repository first (Repositories)."
          action={
            <a className="btn" href="#/repos">
              Open Repositories
            </a>
          }
        />
      ) : null}

      <Section
        title="Reports"
        description="What the scheduled agents produced — digests, stale sweeps, CI analyses."
      >
        {workspaceReports.length === 0 ? (
          <EmptyState title="No reports yet" hint="Enable a daily digest or stale sweep above and reports will land here." />
        ) : (
          <div className="flex flex-col gap-2.5">
            {workspaceReports.map((r) => (
              <details key={r.id} className="card">
                <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm select-none">
                  <span className="badge">{r.kind}</span>
                  <strong className="min-w-0 flex-1 truncate">{r.title}</strong>
                  {r.repo ? <span className="dim">{r.repo}</span> : null}
                  <span className="dim">{timeAgo(r.createdAt)}</span>
                </summary>
                <div className="mt-2.5 border-t border-zinc-200 pt-2.5 dark:border-zinc-800">
                  <Markdown text={r.body} />
                </div>
              </details>
            ))}
          </div>
        )}
      </Section>
    </Page>
  );
}

const AUTOMATIONS: ReadonlyArray<{
  field: 'autoTriage' | 'digest' | 'staleSweep' | 'prGate';
  isOn: (r: RepoRecord) => boolean;
  label: string;
  description: string;
}> = [
  {
    field: 'autoTriage',
    isOn: (r) => r.autoTriage,
    label: 'Auto-triage new issues',
    description: 'An agent labels, de-duplicates, and summarizes every new issue as it syncs.',
  },
  {
    field: 'digest',
    isOn: (r) => r.digestEnabled,
    label: 'Daily digest',
    description: 'A scheduled report of new issues with a prioritized what-matters summary.',
  },
  {
    field: 'staleSweep',
    isOn: (r) => r.staleSweepEnabled,
    label: 'Stale sweep',
    description: 'Flags issues and pull requests that have gone quiet for too long.',
  },
  {
    field: 'prGate',
    isOn: (r) => r.prGateEnabled,
    label: 'PR gate',
    description: 'Auto AI review on newly opened PRs (CI-aware); posts to GitHub when confident.',
  },
];

function RepoAutomation({
  repo,
  onChange,
  onError,
}: {
  repo: RepoRecord;
  onChange: () => Promise<void>;
  onError: (e: string) => void;
}): JSX.Element {
  const [webhook, setWebhook] = useState<WebhookInfo | null>(null);
  const [busy, setBusy] = useState(false);

  const act = (fn: () => Promise<unknown>) => async (): Promise<void> => {
    setBusy(true);
    try {
      await fn();
      await onChange();
    } catch (err) {
      onError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="card" aria-label={repo.fullName}>
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-sm">{repo.fullName}</strong>
        {repo.webhookConfigured ? <span className="badge-ok">webhook active</span> : null}
      </div>

      <div className="mt-3 divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-800/60 dark:border-zinc-800">
        {AUTOMATIONS.map((a) => (
          <div key={a.field} className="flex items-center gap-3 px-3.5 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">{a.label}</div>
              <p className="dim mt-0.5">{a.description}</p>
            </div>
            <Switch
              label={`${a.label} for ${repo.fullName}`}
              checked={a.isOn(repo)}
              disabled={busy}
              onChange={(v) => void act(() => api.setAutomation(repo.fullName, { [a.field]: v }))()}
            />
          </div>
        ))}
      </div>

      <div className="mt-3.5 flex flex-wrap items-center gap-2 border-t border-zinc-200 pt-3.5 dark:border-zinc-800">
        <button className="btn-ghost" disabled={busy} onClick={() => void act(() => api.digestNow(repo.fullName))()}>
          Digest now
        </button>
        <button className="btn-ghost" disabled={busy} onClick={() => void act(() => api.staleNow(repo.fullName))()}>
          Stale sweep now
        </button>
        <span className="flex-1" />
        <button
          className="btn-ghost"
          disabled={busy}
          onClick={() =>
            void api
              .webhookInfo(repo.fullName)
              .then((info) => {
                setWebhook(info);
                void onChange();
              })
              .catch((e) => onError(String(e)))
          }
        >
          {repo.webhookConfigured ? 'Webhook info' : 'Enable webhook'}
        </button>
      </div>

      {webhook ? (
        <div className="banner-info mb-0 flex-col items-start gap-1.5">
          <div>
            Point a GitHub webhook (content type <code>application/json</code>, events: issues + pull requests) at:
          </div>
          <CopyText value={webhook.path} title="Copy webhook path">
            <code className="text-xs break-all">http://&lt;your-tunnel&gt;{webhook.path}</code>
          </CopyText>
          <div className="flex items-center gap-1.5">
            Secret:
            <CopyText value={webhook.secret} title="Copy webhook secret">
              <code className="text-xs break-all">{webhook.secret}</code>
            </CopyText>
          </div>
        </div>
      ) : null}
    </article>
  );
}
