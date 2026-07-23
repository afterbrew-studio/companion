import { useCallback, useEffect, useState } from 'react';
import { useLive } from '@companion/core/client';
import type { BriefingCadence, GitHubAccountRecord, RepoRecord, WebhookInfo } from '@companion/module-code/contract';
import { codeApi, RepoUnavailableRow } from '@companion/module-code/client';
import { modulesApi, useAuth } from '@companion/module-core/client';
import type { WebhookTunnelState } from '@companion/module-operate/contract';
import type { ReportRecord } from '@companion/module-workspace/contract';
import { CopyText, EmptyState, ErrorBar, ListCard, MetaSignal, Page, PageHeader, Section, SettingRow, Switch, timeAgo } from '@companion/ui';
import { automationsApi as api } from '../api.js';
import { useAutomations } from '../hooks/useAutomations.js';
import { ReportCard } from '../components/ReportCard.js';

/** Per-repo automation switches + the report feed they produce, workspace-scoped. */
export function AutomationsPage(): JSX.Element {
  const { current, repos, reports, error, setError, refresh } = useAutomations();

  if (!current) {
    return (
      <Page>
        <EmptyState title="No workspace yet" hint="Create a workspace from the sidebar switcher first." />
      </Page>
    );
  }

  const repoNames = new Set(repos.map((r) => r.fullName));
  const workspaceReports = reports.filter((r) => r.repo === null || repoNames.has(r.repo));
  // One collapsed group per source, newest-first: each repo, plus "Workspace"
  // for repo-less reports (briefings). The feed arrives newest-first already.
  const byRepo = new Map<string | null, ReportRecord[]>();
  for (const r of workspaceReports) {
    const group = byRepo.get(r.repo) ?? [];
    group.push(r);
    byRepo.set(r.repo, group);
  }
  const reportGroups = [...byRepo.entries()]
    .map(([repo, group]) => ({ repo, group }))
    .sort((a, b) => (b.group[0]?.createdAt ?? 0) - (a.group[0]?.createdAt ?? 0));

  return (
    <Page>
      <PageHeader
        title="Automations"
        subtitle={`${current.name} — webhook receivers and scheduled agents, per repository`}
      />
      <ErrorBar error={error} />

      <WorkspaceBriefingCard workspaceId={current.id} onError={setError} onSent={refresh} />

      <WebhookTunnelCard />

      <div className="mt-3 flex flex-col gap-3">
        {repos.map((repo) => (
          repo.githubAccessible ? (
            <RepoAutomation key={repo.fullName} repo={repo} onChange={refresh} onError={setError} />
          ) : (
            <article key={repo.fullName} className="card overflow-hidden p-0 opacity-70">
              <RepoUnavailableRow repo={repo.fullName} />
            </article>
          )
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
        description="What the scheduled agents produced — briefings, digests, stale sweeps, CI analyses."
      >
        {workspaceReports.length === 0 ? (
          <EmptyState title="No reports yet" hint="Enable a daily digest or stale sweep above and reports will land here." />
        ) : (
          <div className="flex flex-col gap-2.5">
            {reportGroups.map(({ repo, group }) => (
              <details key={repo ?? 'workspace'} className="card">
                <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm select-none">
                  <strong className="min-w-0 flex-1 truncate">{repo ?? 'Workspace'}</strong>
                  <span className="dim text-xs">{[...new Set(group.map((r) => r.kind))].join(' · ')}</span>
                  <span className="dim">
                    {group.length} · {timeAgo(group[0]!.createdAt)}
                  </span>
                </summary>
                <div className="mt-2.5 flex flex-col gap-2 border-t border-zinc-200 pt-2.5 dark:border-zinc-800">
                  {group.map((r) => (
                    <ReportCard key={r.id} report={r} />
                  ))}
                </div>
              </details>
            ))}
          </div>
        )}
      </Section>
    </Page>
  );
}

/** Workspace-level scheduled report: one briefing covering every repo. */
function WorkspaceBriefingCard({
  workspaceId,
  onError,
  onSent,
}: {
  workspaceId: string;
  onError: (e: string) => void;
  onSent: () => Promise<void>;
}): JSX.Element {
  const [cadence, setCadence] = useState<BriefingCadence | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    setCadence(null);
    api
      .getBriefing(workspaceId)
      .then((r) => setCadence(r.cadence))
      .catch((err) => {
        setCadence('off');
        onError(String(err));
      });
    // onError is a stable setState — reloading on workspace switch is what matters.
  }, [workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (next: BriefingCadence): Promise<void> => {
    const prev = cadence;
    setCadence(next);
    setBusy(true);
    try {
      await api.setBriefing(workspaceId, next);
    } catch (err) {
      setCadence(prev);
      onError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const sendNow = async (): Promise<void> => {
    setSending(true);
    try {
      await api.briefingNow(workspaceId);
      await onSent();
    } catch (err) {
      onError(String(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <article className="card" aria-label="Workspace briefing">
      <SettingRow
        title="Workspace briefing"
        description="Everything that needs you, agent activity, CI health, hot issues, and velocity — in one report."
      >
        <select
          className="input input-sm"
          aria-label="Briefing cadence"
          value={cadence ?? 'off'}
          disabled={cadence === null || busy}
          onChange={(e) => void save(e.target.value as BriefingCadence)}
        >
          <option value="off">Off</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
        </select>
        <button className="btn-ghost" disabled={sending} onClick={() => void sendNow()}>
          {sending ? 'Sending…' : 'Send now'}
        </button>
      </SettingRow>
    </article>
  );
}

/**
 * Instance-wide tunnel status + its directly relevant module-config toggle.
 * State changes broadcast `modules.changed`, so relay failure/retry stays live.
 */
function WebhookTunnelCard(): JSX.Element | null {
  const { can } = useAuth();
  const [tunnel, setTunnel] = useState<WebhookTunnelState | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(
    () =>
      api
        .webhookTunnel()
        .then(setTunnel)
        .catch(() => setTunnel(null)),
    [],
  );
  useLive(refresh, (msg) => msg.t === 'modules.changed');

  if (!tunnel) return null;

  const configure = async (enabled: boolean): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      await modulesApi.setConfig('operate', { webhookTunnel: enabled });
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const retry = async (): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      setTunnel(await api.retryWebhookTunnel());
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const signal =
    tunnel.status === 'connected'
      ? { tone: 'green' as const, label: 'connected' }
      : tunnel.status === 'error'
        ? { tone: 'red' as const, label: 'connection error' }
        : tunnel.status === 'connecting'
          ? { tone: 'amber' as const, label: 'connecting' }
          : { tone: 'zinc' as const, label: 'off' };

  return (
    <article className="card mt-3" aria-label="Public webhook delivery">
      <SettingRow
        title={
          <span className="flex flex-wrap items-center gap-2">
            Public webhook delivery
            <MetaSignal tone={signal.tone} label={signal.label} pulse={tunnel.status === 'connecting'} />
          </span>
        }
        description="Routes GitHub deliveries through the moxxy proxy — no tunnel or port-forward of your own needed. The URL is stable across restarts."
      >
        {can('settings:manage') ? (
          <Switch
            checked={tunnel.enabled}
            disabled={busy}
            label="Public webhook delivery"
            onChange={(enabled) => void configure(enabled)}
          />
        ) : null}
      </SettingRow>
      <ErrorBar error={actionError} className="mt-2.5" />
      {tunnel.enabled ? (
        <div className="mt-2.5 border-t border-zinc-200 pt-2.5 text-[13px] dark:border-zinc-800">
          {tunnel.status === 'connected' && tunnel.url ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="dim">Base URL:</span>
              <CopyText value={tunnel.url} title="Copy public base URL">
                <code className="code-inline break-all">{tunnel.url}</code>
              </CopyText>
            </div>
          ) : null}
          {tunnel.status === 'connecting' ? (
            <p className="dim">Establishing secure relay connection…</p>
          ) : null}
          {tunnel.status === 'error' ? (
            <div className="flex flex-col items-start gap-2">
              <ErrorBar error={tunnel.error} />
              {can('settings:manage') ? (
                <button className="btn-ghost" disabled={busy} onClick={() => void retry()}>
                  {busy ? 'Retrying…' : 'Retry now'}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

const AUTOMATIONS: ReadonlyArray<{
  field: 'autoTriage' | 'digest' | 'staleSweep' | 'prGate' | 'autoMerge';
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
  {
    field: 'autoMerge',
    isOn: (r) => r.autoMergeEnabled,
    label: 'Auto-merge',
    description: 'Squash-merges PRs that are CI-green, human-approved, and AI-reviewed low risk.',
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
  const { user } = useAuth();
  const [webhook, setWebhook] = useState<WebhookInfo | null>(null);
  const [accounts, setAccounts] = useState<readonly GitHubAccountRecord[]>([]);
  const [accountId, setAccountId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void codeApi
      .listGithubAccounts()
      .then(({ accounts: rows }) => {
        const eligible = rows.filter((account) => account.purposes.includes('webhooks'));
        setAccounts(eligible);
        setAccountId((current) => current || eligible[0]?.id || '');
      })
      .catch((err) => onError(String(err)));
    if (repo.webhookConfigured) {
      void api
        .getWebhook(repo.fullName)
        .then(({ webhook: info }) => setWebhook(info))
        .catch((err) => onError(String(err)));
    }
  }, [repo.fullName, repo.webhookConfigured]); // eslint-disable-line react-hooks/exhaustive-deps

  const automationsManagedByYou = repo.automationOwnerId === null || repo.automationOwnerId === user?.username;

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

  const toggleWebhook = async (on: boolean): Promise<void> => {
    setBusy(true);
    try {
      if (on) {
        // Enabling surfaces the URL + secret right away.
        if (!accountId) throw new Error('Connect one of your GitHub accounts and enable it for webhooks first.');
        setWebhook(await api.enableWebhook(repo.fullName, accountId));
      } else {
        await api.disableWebhook(repo.fullName);
        setWebhook(null);
      }
      await onChange();
    } catch (err) {
      onError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="card" aria-label={repo.fullName}>
      <div className="flex flex-wrap items-center gap-2.5">
        <strong className="text-sm">{repo.fullName}</strong>
        {repo.webhookConfigured ? (
          <MetaSignal tone="green" label="webhook active" title="Receiving GitHub deliveries for this repo" />
        ) : null}
        {repo.automationOwnerId && !automationsManagedByYou ? (
          <MetaSignal
            tone="zinc"
            label="automations unavailable"
            title={`Managed by ${repo.automationOwnerId}; their personal GitHub credentials are never shared.`}
          />
        ) : null}
      </div>

      <ListCard subtle className="mt-3">
        {!repo.webhookConfigured || webhook?.managedByYou ? (
          <SettingRow
            className="px-3.5 py-2.5"
            title="Webhook owner"
            description="This personal account must retain access to the repository."
          >
            <select
              className="input input-sm"
              value={webhook?.accountId ?? accountId}
              disabled={busy || repo.webhookConfigured}
              onChange={(event) => setAccountId(event.target.value)}
              aria-label={`GitHub account owning the webhook for ${repo.fullName}`}
            >
              {accounts.length === 0 ? <option value="">No eligible account</option> : null}
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.login}
                </option>
              ))}
            </select>
          </SettingRow>
        ) : null}
        <SettingRow
          className="px-3.5 py-2.5"
          title="GitHub webhook"
          description="Receive deliveries for this repo — events sync instantly and trigger the automations below."
        >
          <Switch
            label={`GitHub webhook for ${repo.fullName}`}
            checked={repo.webhookConfigured}
            disabled={
              busy ||
              (!repo.webhookConfigured && !accountId) ||
              (repo.webhookConfigured && webhook?.managedByYou !== true)
            }
            onChange={(v) => void toggleWebhook(v)}
          />
        </SettingRow>
        {AUTOMATIONS.map((a) => (
          <SettingRow key={a.field} className="px-3.5 py-2.5" title={a.label} description={a.description}>
            <span
              title={
                automationsManagedByYou
                  ? undefined
                  : `Managed by ${repo.automationOwnerId}; their personal GitHub credentials are never shared.`
              }
            >
              <Switch
                label={`${a.label} for ${repo.fullName}`}
                checked={a.isOn(repo)}
                disabled={busy || !automationsManagedByYou}
                onChange={(v) => void act(() => api.setAutomation(repo.fullName, { [a.field]: v }))()}
              />
            </span>
          </SettingRow>
        ))}
      </ListCard>

      <div className="mt-3.5 flex flex-wrap items-center gap-2 border-t border-zinc-200 pt-3.5 dark:border-zinc-800">
        <button className="btn-ghost" disabled={busy} onClick={() => void act(() => api.digestNow(repo.fullName))()}>
          Digest now
        </button>
        <button className="btn-ghost" disabled={busy} onClick={() => void act(() => api.staleNow(repo.fullName))()}>
          Stale sweep now
        </button>
        <span className="flex-1" />
        {repo.webhookConfigured ? (
          <button
            className="btn-ghost"
            disabled={busy}
            onClick={() => {
              if (webhook) {
                setWebhook(null);
                return;
              }
              void api
                .getWebhook(repo.fullName)
                .then((r) => setWebhook(r.webhook))
                .catch((e) => onError(String(e)));
            }}
          >
            {webhook ? 'Hide webhook info' : 'Webhook info'}
          </button>
        ) : null}
      </div>

      {webhook ? (
        <div className="banner-info mb-0 flex-col items-start gap-1.5">
          <div>
            Point a GitHub webhook (content type <code>application/json</code>, events: issues + pull requests) at:
          </div>
          {webhook.url ? (
            <CopyText value={webhook.url} title="Copy webhook URL">
              <code className="code-inline break-all">{webhook.url}</code>
            </CopyText>
          ) : (
            <>
              <CopyText value={webhook.path} title="Copy webhook path">
                <code className="code-inline break-all">http://&lt;your-tunnel&gt;{webhook.path}</code>
              </CopyText>
              <div className="dim">Enable public webhook delivery above to get a ready-to-paste URL.</div>
            </>
          )}
          {webhook.secret ? (
            <div className="flex items-center gap-1.5">
              Secret:
              <CopyText value={webhook.secret} title="Copy webhook secret">
                <code className="code-inline break-all">{webhook.secret}</code>
              </CopyText>
            </div>
          ) : (
            <div className="dim">Managed by another Companion profile. Its secret and credentials stay private.</div>
          )}
          <div className="dim mt-1 w-full border-t border-zinc-300/60 pt-2 dark:border-zinc-700">
            Turning the webhook off rejects future deliveries here; also delete the webhook on GitHub to stop them at
            the source.
          </div>
        </div>
      ) : null}
    </article>
  );
}
