import { useCallback, useEffect, useState } from 'react';
import { useLive } from '@companion/core/client';
import type { BriefingCadence, RepoRecord, WebhookInfo } from '@companion/module-code/contract';
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
                  {[...new Set(group.map((r) => r.kind))].map((kind) => (
                    <span key={kind} className="badge">
                      {kind}
                    </span>
                  ))}
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
 * Instance-wide tunnel status (read-only here): the toggle is operate's
 * `webhookTunnel` module config, edited under Modules → Operate → Configure.
 * Config changes broadcast `modules.changed`, so the card follows edits live.
 */
function WebhookTunnelCard(): JSX.Element | null {
  const [tunnel, setTunnel] = useState<WebhookTunnelState | null>(null);

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

  return (
    <article className="card mt-3" aria-label="Public webhook delivery">
      <SettingRow
        title={
          <span className="flex flex-wrap items-center gap-2">
            Public webhook delivery
            <MetaSignal tone={tunnel.enabled ? 'green' : 'zinc'} label={tunnel.enabled ? 'on' : 'off'} />
          </span>
        }
        description="Routes GitHub deliveries through the moxxy proxy — no tunnel or port-forward of your own needed. The URL is stable across restarts."
      >
        <a className="btn-ghost" href="#/modules">
          Configure in Modules
        </a>
      </SettingRow>
      {tunnel.enabled ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-zinc-200 pt-2.5 text-[13px] dark:border-zinc-800">
          <span className="dim">Base URL:</span>
          {tunnel.url ? (
            <CopyText value={tunnel.url} title="Copy public base URL">
              <code className="code-inline break-all">{tunnel.url}</code>
            </CopyText>
          ) : (
            <span className="badge-warn">connecting…</span>
          )}
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

  const toggleWebhook = async (on: boolean): Promise<void> => {
    setBusy(true);
    try {
      if (on) {
        // Enabling surfaces the URL + secret right away.
        setWebhook(await api.enableWebhook(repo.fullName));
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
      </div>

      <ListCard subtle className="mt-3">
        <SettingRow
          className="px-3.5 py-2.5"
          title="GitHub webhook"
          description="Receive deliveries for this repo — events sync instantly and trigger the automations below."
        >
          <Switch
            label={`GitHub webhook for ${repo.fullName}`}
            checked={repo.webhookConfigured}
            disabled={busy}
            onChange={(v) => void toggleWebhook(v)}
          />
        </SettingRow>
        {AUTOMATIONS.map((a) => (
          <SettingRow key={a.field} className="px-3.5 py-2.5" title={a.label} description={a.description}>
            <Switch
              label={`${a.label} for ${repo.fullName}`}
              checked={a.isOn(repo)}
              disabled={busy}
              onChange={(v) => void act(() => api.setAutomation(repo.fullName, { [a.field]: v }))()}
            />
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
          <div className="flex items-center gap-1.5">
            Secret:
            <CopyText value={webhook.secret} title="Copy webhook secret">
              <code className="code-inline break-all">{webhook.secret}</code>
            </CopyText>
          </div>
          <div className="dim mt-1 w-full border-t border-zinc-300/60 pt-2 dark:border-zinc-700">
            Turning the webhook off rejects future deliveries here; also delete the webhook on GitHub to stop them at
            the source.
          </div>
        </div>
      ) : null}
    </article>
  );
}
