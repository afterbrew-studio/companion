import { useCallback, useEffect, useRef, useState } from 'react';
import { useLive, useModuleEnabled } from '@moxxy/companion-sdk/client';
import type { Permission } from '@moxxy/companion-contracts';
import type {
  BriefingCadence,
  GitHubAccountRecord,
  RepoPreset,
  RepoPresetId,
  RepoPresetResult,
  RepoRecord,
  WebhookInfo,
} from '@companion/module-code/contract';
import type {
  ActionableIssueKind,
  AutomationAdmissionControl,
  AutomationDeliveryHealth,
  ContributorFlowDryRun,
  ContributorFlowMode,
  ContributorFlowPolicy,
  WorkspaceBriefingSchedule,
} from '../../contract/index.js';
import { codeApi, RepoUnavailableRow } from '@companion/module-code/client';
import { modulesApi, useAuth } from '@companion/module-core/client';
import type { WebhookTunnelState } from '@companion/module-operate/contract';
import type { ReportRecord } from '@companion/module-workspace/contract';
import { CopyText, EmptyState, ErrorBar, Eyebrow, ListCard, MetaSignal, Modal, Page, PageHeader, RowsSkeleton, Section, SettingRow, Skeleton, Switch, timeAgo } from '@moxxy/companion-sdk/ui';
import { automationsApi as api } from '../api.js';
import { useAutomations } from '../hooks/useAutomations.js';
import { ReportCard } from '../components/ReportCard.js';

/** Workspace-wide automation health. Repository policy is configured from the
 * repository that owns it, not from this aggregate surface. */
export function AutomationsPage(): React.JSX.Element {
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
        title="Automation health"
        subtitle={`${current.name} — workspace briefing, public delivery and durable webhook work`}
        actions={
          <a className="btn-ghost" href="#/repos">
            Repositories
          </a>
        }
      />
      <ErrorBar error={error} />

      <WorkspaceBriefingCard workspaceId={current.id} onError={setError} onSent={refresh} />

      <WebhookTunnelCard />

      <DeliveryHealthCard workspaceId={current.id} />

      <Section
        title="Reports"
        description="What the scheduled agents produced — briefings, digests, stale sweeps, CI analyses."
      >
        {workspaceReports.length === 0 ? (
          <EmptyState
            title="No reports yet"
            hint="Configure a digest or stale sweep from its repository and the results will land here."
          />
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

/** The repository is the natural configuration boundary for webhook-driven
 * and scheduled work. This route is contributed by Automations into Code's
 * repository hub, keeping module ownership one-way. */
export function RepositoryAutomationsPage({ repo: fullName }: { repo: string }): React.JSX.Element {
  const { current, repos, reposLoaded, reports, error, setError, refresh } = useAutomations();
  const { can } = useAuth();
  const {
    flows,
    controls,
    loaded: policiesLoaded,
    error: policiesError,
    refresh: refreshPolicies,
  } = useRepositoryAutomationPolicies(current?.id);

  if (!current) {
    return (
      <Page>
        <EmptyState title="No workspace yet" hint="Create a workspace from the sidebar switcher first." />
      </Page>
    );
  }

  const repo = repos.find((candidate) => candidate.fullName === fullName) ?? null;
  if (!reposLoaded) {
    return (
      <Page>
        <PageHeader title={fullName} subtitle="Loading repository automations…" />
        <div className="card"><RowsSkeleton rows={5} /></div>
      </Page>
    );
  }
  if (!repo) {
    return (
      <Page>
        <EmptyState
          title="Repository is not connected here"
          hint={`${fullName} does not belong to ${current.name}. Open Repositories to choose a connected project.`}
          action={<a className="btn" href="#/repos">Open Repositories</a>}
        />
      </Page>
    );
  }
  if (!policiesLoaded) {
    return (
      <Page>
        <PageHeader
          title={repo.fullName}
          subtitle="Loading repository automations…"
          actions={<a className="btn-ghost" href="#/repos">Repositories</a>}
        />
        <ErrorBar error={policiesError ?? error} />
        <div className="card">
          {policiesError ? (
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <span>Automation policy could not be loaded, so no editable defaults are being shown.</span>
              <button className="btn-ghost" onClick={() => void refreshPolicies()}>Retry</button>
            </div>
          ) : <RowsSkeleton rows={5} />}
        </div>
      </Page>
    );
  }

  const repoReports = reports.filter((report) => report.repo === repo.fullName);
  const flow = flows.find((candidate) => candidate.repo === repo.fullName) ?? null;
  const admission = controls.find((candidate) => candidate.repo === repo.fullName) ?? {
    repo: repo.fullName,
    paused: false,
    reason: null,
    pausedBy: null,
    pausedAt: null,
  };

  return (
    <Page>
      <PageHeader
        title={repo.fullName}
        subtitle="Repository automations — webhooks, digests and the issue-to-merge lifecycle"
        actions={
          <>
            <a className="btn-ghost" href="#/repos/automation-health">Automation health</a>
            <a className="btn-ghost" href="#/repos">Repositories</a>
          </>
        }
      />
      <ErrorBar error={policiesError ?? error} />

      {repo.githubAccessible || can('users:manage') ? (
        <RepoAutomation
          workspaceId={current.id}
          repo={repo}
          flow={flow}
          admission={admission}
          onFlowChange={refreshPolicies}
          onChange={refresh}
          onError={setError}
        />
      ) : (
        <article className="card overflow-hidden p-0 opacity-70">
          <RepoUnavailableRow repo={repo.fullName} />
        </article>
      )}

      <Section
        title="Repository reports"
        description="Digests, stale sweeps and CI analyses produced for this repository."
      >
        {repoReports.length === 0 ? (
          <EmptyState
            title="No repository reports yet"
            hint="Enable a digest or stale sweep above, or run one now."
          />
        ) : (
          <div className="flex flex-col gap-2.5">
            {repoReports.map((report) => <ReportCard key={report.id} report={report} />)}
          </div>
        )}
      </Section>
    </Page>
  );
}

function useRepositoryAutomationPolicies(
  workspaceId: string | undefined,
): {
  flows: ContributorFlowPolicy[];
  controls: AutomationAdmissionControl[];
  loaded: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const workspaceRef = useRef(workspaceId);
  workspaceRef.current = workspaceId;
  const [state, setState] = useState<{
    workspaceId: string | undefined;
    flows: ContributorFlowPolicy[];
    controls: AutomationAdmissionControl[];
    loaded: boolean;
    error: string | null;
  }>({ workspaceId, flows: [], controls: [], loaded: false, error: null });
  const refresh = useCallback(async (): Promise<void> => {
    if (!workspaceId) {
      setState({ workspaceId, flows: [], controls: [], loaded: true, error: null });
      return;
    }
    try {
      const [flowResult, controlResult] = await Promise.all([
        api.contributorFlows(workspaceId),
        api.admissionControls(workspaceId),
      ]);
      if (workspaceRef.current === workspaceId) {
        setState({
          workspaceId,
          flows: flowResult.flows,
          controls: controlResult.controls,
          loaded: true,
          error: null,
        });
      }
    } catch (err) {
      if (workspaceRef.current === workspaceId) {
        setState({ workspaceId, flows: [], controls: [], loaded: false, error: String(err) });
      }
    }
  }, [workspaceId]);

  useLive(refresh, (msg) => msg.t === 'automations.changed' && (msg.area === 'flows' || msg.area === 'controls'));
  const current = state.workspaceId === workspaceId
    ? state
    : { workspaceId, flows: [], controls: [], loaded: false, error: null };
  return { ...current, refresh };
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
}): React.JSX.Element {
  const { can, user } = useAuth();
  const [schedule, setSchedule] = useState<WorkspaceBriefingSchedule | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setSchedule(await api.getBriefing(workspaceId));
    } catch (err) {
      setSchedule(null);
      onError(String(err));
    }
  }, [workspaceId, onError]);

  useEffect(() => {
    setSchedule(null);
    void refresh();
  }, [refresh]);
  useLive(refresh, (msg) => msg.t === 'automations.changed' && msg.area === 'briefing');

  const required: readonly Permission[] = ['issues:read', 'prs:read', 'reports:read'];
  const missing = required.filter((permission) => !can(permission));
  const canRun = missing.length === 0;
  const foreignOwner = schedule?.ownerId && schedule.ownerId !== user?.username ? schedule.ownerId : null;
  const canBreakGlass = can('users:manage');
  const canEditSchedule = !foreignOwner || canBreakGlass;

  const save = async (next: BriefingCadence): Promise<void> => {
    const previous = schedule;
    if (!previous) return;
    setSchedule({ cadence: next, ownerId: next === 'off' ? null : (user?.username ?? previous.ownerId) });
    setBusy(true);
    try {
      setSchedule(await api.setBriefing(workspaceId, next));
    } catch (err) {
      setSchedule(previous);
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
        {schedule?.cadence === 'off' ? (
          <MetaSignal tone="zinc" label="off" />
        ) : schedule?.ownerId === user?.username ? (
          <MetaSignal tone="green" label="runs as you" />
        ) : foreignOwner ? (
          <MetaSignal
            tone={canBreakGlass ? 'amber' : 'zinc'}
            label={canBreakGlass ? 'admin takeover available' : `managed by @${foreignOwner}`}
            title={`The schedule runs only with @${foreignOwner}'s live permissions. Personal GitHub credentials are never shared.`}
          />
        ) : schedule ? (
          <MetaSignal tone="red" label="owner required" title="Re-save or disable this legacy schedule." />
        ) : (
          <MetaSignal tone="zinc" label="loading" pulse />
        )}
        <select
          className="input input-sm"
          aria-label="Briefing cadence"
          title={
            !canEditSchedule
              ? `Managed by @${foreignOwner}`
              : missing.length > 0
                ? `Enabling requires ${missing.join(', ')}; turning it off remains available.`
                : undefined
          }
          value={schedule?.cadence ?? 'off'}
          disabled={schedule === null || busy || !canEditSchedule}
          onChange={(e) => void save(e.target.value as BriefingCadence)}
        >
          <option value="off">Off</option>
          <option value="daily" disabled={!canRun}>Daily</option>
          <option value="weekly" disabled={!canRun}>Weekly</option>
        </select>
        <button
          className="btn-ghost"
          disabled={sending || schedule === null || !canRun}
          title={missing.length > 0 ? `Requires ${missing.join(', ')}` : undefined}
          onClick={() => void sendNow()}
        >
          {sending ? 'Sending…' : 'Send now'}
        </button>
      </SettingRow>
      {foreignOwner && canBreakGlass ? (
        <div className="banner-warn mb-0 mt-3 text-xs" role="status">
          Break-glass administration: Off stops the schedule without borrowing credentials. Choosing a cadence
          validates your own access to every repository before assigning the schedule to you.
        </div>
      ) : missing.length > 0 ? (
        <p className="dim mt-2 text-xs">Your role is missing {missing.join(', ')}. You can still turn off a schedule you own.</p>
      ) : null}
    </article>
  );
}

/**
 * Instance-wide tunnel status + its directly relevant module-config toggle.
 * State changes broadcast `modules.changed`, so relay failure/retry stays live.
 */
function WebhookTunnelCard(): React.JSX.Element | null {
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
      ? { tone: 'green' as const, label: tunnel.source === 'external' ? 'self-managed' : 'connected' }
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
        description={
          tunnel.source === 'external'
            ? 'Uses the self-managed public URL configured for Operate; webhook secrets stay server-side.'
            : 'Routes GitHub deliveries through the moxxy proxy — no tunnel or port-forward of your own needed. The URL is stable across restarts.'
        }
      >
        {can('settings:manage') && tunnel.source !== 'external' ? (
          <Switch
            checked={tunnel.enabled}
            disabled={busy}
            label="Public webhook delivery"
            onChange={(enabled) => void configure(enabled)}
          />
        ) : tunnel.source === 'external' ? (
          <a className="btn-ghost" href="#/settings/modules">Configure</a>
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

/** Durable webhook work, including the stage a long triage/review is in. */
function DeliveryHealthCard({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const [health, setHealth] = useState<AutomationDeliveryHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setHealth(await api.deliveryHealth(workspaceId));
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [workspaceId]);
  useEffect(() => {
    setHealth(null);
    void refresh();
  }, [refresh]);
  useLive(refresh, (msg) => msg.t === 'automations.changed' && msg.area === 'deliveries');

  const active = (health?.queued ?? 0) + (health?.processing ?? 0) + (health?.retrying ?? 0);
  const retry = async (id: string): Promise<void> => {
    setRetrying(id);
    try {
      await api.retryDelivery(workspaceId, id);
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setRetrying(null);
    }
  };

  return (
    <article className="card mt-3" aria-label="Webhook work queue">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <strong className="text-sm">Webhook work queue</strong>
          <p className="dim mt-0.5 text-xs">Durable across restarts; long issue and PR work reports its current stage here.</p>
        </div>
        {health === null ? (
          <MetaSignal tone="zinc" label="loading" pulse />
        ) : active > 0 ? (
          <MetaSignal tone="blue" label={`${active} active`} pulse={health.processing > 0} />
        ) : health.failed > 0 ? (
          <MetaSignal tone="red" label={`${health.failed} need attention`} />
        ) : (
          <MetaSignal tone="green" label="healthy" />
        )}
      </div>
      <ErrorBar error={error} className="mt-2.5" />
      {health && (health.recent.length > 0 || active > 0 || health.failed > 0) ? (
        <details className="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-800" open={active > 0 || health.failed > 0}>
          <summary className="cursor-pointer text-xs font-medium select-none">
            {health.processing} processing · {health.queued} queued · {health.retrying} retrying · {health.failed} failed
          </summary>
          <div className="mt-2 flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
            {health.recent.slice(0, 20).map((delivery) => (
              <div key={delivery.id} className="flex min-w-0 items-center gap-2 py-2 text-xs">
                <MetaSignal
                  tone={
                    delivery.status === 'failed'
                      ? 'red'
                      : delivery.status === 'completed'
                        ? 'green'
                        : delivery.status === 'retrying'
                          ? 'amber'
                          : 'blue'
                  }
                  label={delivery.status}
                  pulse={delivery.status === 'processing'}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {delivery.repo} · {delivery.event}{delivery.action ? `.${delivery.action}` : ''}
                  </span>
                  <span className="dim block truncate" title={delivery.lastError ?? delivery.stage}>
                    {delivery.lastError ?? delivery.stage} · attempt {delivery.attempts}
                    {delivery.nextAttemptAt ? ` · next ${new Date(delivery.nextAttemptAt).toLocaleTimeString()}` : ''}
                    {' · '}{timeAgo(delivery.receivedAt)}
                  </span>
                </span>
                {delivery.status === 'failed' ? (
                  <button className="btn-ghost" disabled={retrying !== null} onClick={() => void retry(delivery.id)}>
                    {retrying === delivery.id ? 'Retrying…' : 'Retry'}
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </article>
  );
}

const AUTOMATIONS: ReadonlyArray<{
  field: 'autoTriage' | 'digest' | 'staleSweep' | 'prGate' | 'autoMerge' | 'reviewReplies';
  isOn: (r: RepoRecord) => boolean;
  label: string;
  description: string;
  requires: readonly Permission[];
}> = [
  {
    field: 'autoTriage',
    isOn: (r) => r.autoTriage,
    label: 'Auto-triage new issues',
    description: 'An agent labels, de-duplicates, and summarizes every new issue as it syncs.',
    requires: ['issues:read', 'issues:act', 'runs:read', 'runs:act'],
  },
  {
    field: 'digest',
    isOn: (r) => r.digestEnabled,
    label: 'Daily digest',
    description: 'A scheduled report of new issues with a prioritized what-matters summary.',
    requires: ['issues:read', 'prs:read', 'runs:read', 'runs:act'],
  },
  {
    field: 'staleSweep',
    isOn: (r) => r.staleSweepEnabled,
    label: 'Stale sweep',
    description: 'Reports open issues that have gone quiet for too long.',
    requires: ['issues:read'],
  },
  {
    field: 'prGate',
    isOn: (r) => r.prGateEnabled,
    label: 'PR gate',
    description: 'Auto AI review on newly opened PRs (CI-aware); posts to GitHub when confident.',
    requires: ['prs:read', 'prs:act', 'runs:read', 'runs:act'],
  },
  {
    field: 'autoMerge',
    isOn: (r) => r.autoMergeEnabled,
    label: 'Auto-merge',
    description: 'Squash-merges PRs that are CI-green, human-approved, and AI-reviewed low risk.',
    requires: ['prs:read', 'prs:act'],
  },
  {
    field: 'reviewReplies',
    isOn: (r) => r.reviewRepliesEnabled,
    label: 'Reply to review threads',
    description:
      'When an author answers one of the agent’s inline comments, it re-reads the code and replies in the thread, publicly on GitHub. At most three replies per thread.',
    requires: ['prs:read', 'prs:act', 'runs:read', 'runs:act'],
  },
];

function RepoAutomation({
  workspaceId,
  repo,
  flow,
  admission,
  onFlowChange,
  onChange,
  onError,
}: {
  workspaceId: string;
  repo: RepoRecord;
  flow: ContributorFlowPolicy | null;
  admission: AutomationAdmissionControl;
  onFlowChange: () => Promise<void>;
  onChange: () => Promise<void>;
  onError: (e: string) => void;
}): React.JSX.Element {
  const { user, can } = useAuth();
  const boardEnabled = useModuleEnabled('board');
  const [webhook, setWebhook] = useState<WebhookInfo | null>(null);
  const [accounts, setAccounts] = useState<readonly GitHubAccountRecord[]>([]);
  const [accountId, setAccountId] = useState('');
  const [busy, setBusy] = useState(false);
  const [admissionBusy, setAdmissionBusy] = useState(false);
  const [pauseReason, setPauseReason] = useState('Operational pause while the repository is inspected');
  const [visibleAdmission, setVisibleAdmission] = useState(admission);

  useEffect(() => setVisibleAdmission(admission), [admission]);

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

  const foreignAutomationOwners = [repo.automationOwnerId, flow?.ownerId]
    .filter((owner): owner is string => Boolean(owner) && owner !== user?.username)
    .filter((owner, index, owners) => owners.indexOf(owner) === index);
  const automationsManagedByYou = foreignAutomationOwners.length === 0;
  const canBreakGlass = can('users:manage');
  const canManageAutomations = automationsManagedByYou || canBreakGlass;
  const flowPermissions: readonly Permission[] = [
    'issues:read',
    'issues:act',
    'prs:read',
    'prs:act',
    'runs:read',
    'runs:act',
    'board:manage',
  ];
  const missingFlowPermissions = flowPermissions.filter((permission) => !can(permission));
  const canRunDigest = ['issues:read', 'prs:read', 'runs:read', 'runs:act'].every((permission) =>
    can(permission as Permission),
  );
  const canRunStale = can('issues:read');

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
        // Enabling reconciles the GitHub-side hook when a public URL exists,
        // and surfaces manual setup state otherwise.
        const selectedAccount = webhook?.accountId ?? accountId;
        if (!selectedAccount) throw new Error('Connect one of your GitHub accounts and enable it for webhooks first.');
        setWebhook(await api.enableWebhook(repo.fullName, selectedAccount));
      } else {
        const result = await api.disableWebhook(repo.fullName);
        setWebhook(null);
        if (result.warning) onError(result.warning);
      }
      await onChange();
    } catch (err) {
      onError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const changeAdmission = async (paused: boolean): Promise<void> => {
    const reason = pauseReason.trim();
    if (paused && reason.length < 3) {
      onError('Record a short reason before pausing new background work.');
      return;
    }
    const previous = visibleAdmission;
    setAdmissionBusy(true);
    setVisibleAdmission(paused
      ? {
          repo: repo.fullName,
          paused: true,
          reason,
          pausedBy: user?.username ?? null,
          pausedAt: Date.now(),
        }
      : { repo: repo.fullName, paused: false, reason: null, pausedBy: null, pausedAt: null });
    try {
      const { control } = await api.setAdmissionControl(workspaceId, repo.fullName, {
        paused,
        reason: paused ? reason : null,
      });
      setVisibleAdmission(control);
      await onFlowChange();
    } catch (err) {
      setVisibleAdmission(previous);
      onError(String(err));
    } finally {
      setAdmissionBusy(false);
    }
  };

  return (
    <article className="card" aria-label={`Automations for ${repo.fullName}`}>
      <div className="flex flex-wrap items-center gap-2.5">
        <strong className="text-sm">Automation policy</strong>
        {repo.webhookConfigured ? (
          webhook?.remoteId ? (
            <MetaSignal tone="green" label="GitHub webhook installed" title={`Managed GitHub webhook #${webhook.remoteId}`} />
          ) : (
            <MetaSignal tone="amber" label="webhook receiver ready" title="Confirm or repair delivery from GitHub" />
          )
        ) : null}
        {!automationsManagedByYou ? (
          <MetaSignal
            tone={canBreakGlass ? 'amber' : 'zinc'}
            label={canBreakGlass ? 'admin takeover available' : 'automations unavailable'}
            title={`Managed by ${foreignAutomationOwners.join(', ')}; personal GitHub credentials are never shared.${canBreakGlass ? ' Save the full flow to revalidate and take ownership, or safely turn work off.' : ''}`}
          />
        ) : null}
        {visibleAdmission.paused ? <MetaSignal tone="red" label="intake paused" /> : null}
      </div>

      <div className={`mt-3 rounded-lg border p-3 ${visibleAdmission.paused ? 'border-red-500/30 bg-red-500/[0.05]' : 'border-zinc-200 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-900/40'}`}>
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium">
              {visibleAdmission.paused ? 'New background admissions are paused' : 'Background admission circuit breaker'}
            </div>
            <p className="dim mt-0.5 text-[11px] leading-relaxed">
              {visibleAdmission.paused
                ? `New signed webhooks receive a retryable 503 and automatic schedules do not start. Already-durable work keeps draining.${visibleAdmission.pausedBy ? ` Paused by ${visibleAdmission.pausedBy}${visibleAdmission.pausedAt ? ` ${timeAgo(visibleAdmission.pausedAt)}` : ''}.` : ''}`
                : 'Pause intake during a forge, runner, model, or database incident without deleting this repository’s configured lifecycle.'}
            </p>
            {visibleAdmission.paused && visibleAdmission.reason ? (
              <p className="mt-1.5 text-xs"><span className="dim">Reason:</span> {visibleAdmission.reason}</p>
            ) : null}
          </div>
          {visibleAdmission.paused ? (
            <button
              className="btn"
              disabled={busy || admissionBusy || !canManageAutomations}
              title={canManageAutomations ? undefined : 'Only the automation owner or a break-glass administrator may resume foreign work.'}
              onClick={() => void changeAdmission(false)}
            >
              {admissionBusy ? 'Resuming…' : 'Resume intake'}
            </button>
          ) : (
            <div className="flex min-w-[16rem] flex-1 flex-wrap items-center justify-end gap-2 sm:flex-initial">
              <input
                className="input input-sm min-w-0 flex-1 sm:w-72"
                value={pauseReason}
                maxLength={500}
                aria-label={`Reason for pausing ${repo.fullName}`}
                onChange={(event) => setPauseReason(event.target.value)}
              />
              <button className="btn-ghost" disabled={busy || admissionBusy || pauseReason.trim().length < 3} onClick={() => void changeAdmission(true)}>
                {admissionBusy ? 'Pausing…' : 'Pause intake'}
              </button>
            </div>
          )}
        </div>
      </div>

      {!automationsManagedByYou && canBreakGlass ? (
        <div className="banner-warn mb-0 mt-3 text-xs" role="status">
          Break-glass administration: disabling is immediate and preserves ownership of unrelated work. Enabling or
          saving an active lifecycle validates your own role and GitHub accounts before ownership moves to you.
        </div>
      ) : null}

      {canManageAutomations ? (
        <>
          <ContributorFlowEditor
            workspaceId={workspaceId}
            repo={repo}
            flow={flow}
            boardEnabled={boardEnabled}
            webhook={webhook}
            webhookAccountId={webhook?.accountId ?? accountId}
            onWebhookChange={setWebhook}
            busy={busy}
            setBusy={setBusy}
            onChanged={async () => {
              await Promise.all([onChange(), onFlowChange()]);
            }}
            onError={onError}
            missingPermissions={missingFlowPermissions}
            githubAccessible={repo.githubAccessible}
          />
          {flow === null ? (
            <PresetPicker
              repo={repo.fullName}
              busy={busy}
              canEnable={repo.githubAccessible}
              onApplied={onChange}
              onError={onError}
              setBusy={setBusy}
            />
          ) : null}
        </>
      ) : null}

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
          description="Install a signed GitHub hook — events sync instantly and enter the durable work queue."
        >
          <Switch
            label={`GitHub webhook for ${repo.fullName}`}
            checked={repo.webhookConfigured}
            disabled={
              busy ||
              (!repo.webhookConfigured && (!accountId || !repo.githubAccessible)) ||
              (repo.webhookConfigured && webhook?.managedByYou !== true && !canBreakGlass)
            }
            onChange={(v) => void toggleWebhook(v)}
          />
        </SettingRow>
        {AUTOMATIONS.map((a) => (
          <SettingRow key={a.field} className="px-3.5 py-2.5" title={a.label} description={a.description}>
            <span
              title={
                canManageAutomations
                  ? a.isOn(repo) || repo.githubAccessible
                    ? a.requires.every(can)
                      ? undefined
                      : `Your role is missing ${a.requires.filter((permission) => !can(permission)).join(', ')}`
                    : 'Connect one of your GitHub accounts before enabling this automation.'
                  : `Managed by ${foreignAutomationOwners.join(', ')}; personal GitHub credentials are never shared.`
              }
            >
              <Switch
                label={`${a.label} for ${repo.fullName}`}
                checked={a.isOn(repo)}
                disabled={
                  busy ||
                  !canManageAutomations ||
                  (!a.isOn(repo) && (!repo.githubAccessible || !a.requires.every(can)))
                }
                onChange={(v) => void act(() => api.setAutomation(repo.fullName, { [a.field]: v }))()}
              />
            </span>
          </SettingRow>
        ))}
      </ListCard>

      <div className="mt-3.5 flex flex-wrap items-center gap-2 border-t border-zinc-200 pt-3.5 dark:border-zinc-800">
        <button
          className="btn-ghost"
          disabled={busy || !repo.githubAccessible || !canRunDigest}
          title={canRunDigest ? undefined : 'Requires issues:read, prs:read, runs:read and runs:act'}
          onClick={() => void act(() => api.digestNow(repo.fullName))()}
        >
          Digest now
        </button>
        <button
          className="btn-ghost"
          disabled={busy || !repo.githubAccessible || !canRunStale}
          title={canRunStale ? undefined : 'Requires issues:read'}
          onClick={() => void act(() => api.staleNow(repo.fullName))()}
        >
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
          {webhook.remoteId ? (
            <div>
              Companion installed and owns GitHub webhook <strong>#{webhook.remoteId}</strong>. It will reconcile the
              URL, event list, and secret when repaired.
            </div>
          ) : (
            <div>
              Automatic GitHub installation is not confirmed. Repair the hook after public delivery is connected;
              its HMAC secret remains write-only on the server.
            </div>
          )}
          {webhook.remoteError ? <ErrorBar error={webhook.remoteError} /> : null}
          {webhook.url ? (
            <CopyText value={webhook.url} title="Copy webhook URL">
              <code className="code-inline break-all">{webhook.url}</code>
            </CopyText>
          ) : (
            <div className="dim">
              Configure the relay above or a self-managed public URL in Operate settings, then repair this hook.
            </div>
          )}
          <div className="dim">The signing secret is stored only by Companion and GitHub; it is never returned to a browser.</div>
          {!webhook.remoteId && webhook.url && webhook.managedByYou ? (
            <button className="btn-ghost mt-1" disabled={busy} onClick={() => void toggleWebhook(true)}>
              {busy ? 'Repairing…' : 'Install or repair on GitHub'}
            </button>
          ) : null}
          <div className="dim mt-1 w-full border-t border-zinc-300/60 pt-2 dark:border-zinc-700">
            Turning this off rejects deliveries immediately and removes the GitHub hook when Companion installed it.
            A manually created hook must still be removed at the source.
          </div>
        </div>
      ) : null}
    </article>
  );
}

const DEFAULT_ACTIONABLE_KINDS: readonly ActionableIssueKind[] = ['bug', 'docs', 'chore'];

/** One coherent issue → PR lifecycle, with advanced choices kept secondary. */
function ContributorFlowEditor({
  workspaceId,
  repo,
  flow,
  boardEnabled,
  webhook,
  webhookAccountId,
  onWebhookChange,
  busy,
  setBusy,
  onChanged,
  onError,
  missingPermissions,
  githubAccessible,
}: {
  workspaceId: string;
  repo: RepoRecord;
  flow: ContributorFlowPolicy | null;
  boardEnabled: boolean;
  webhook: WebhookInfo | null;
  webhookAccountId: string;
  onWebhookChange: (webhook: WebhookInfo) => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
  missingPermissions: readonly Permission[];
  githubAccessible: boolean;
}): React.JSX.Element {
  const [mode, setMode] = useState<ContributorFlowMode>(flow?.mode ?? 'off');
  const [kinds, setKinds] = useState<ActionableIssueKind[]>([...(flow?.actionableIssueKinds ?? DEFAULT_ACTIONABLE_KINDS)]);
  const [queueIssues, setQueueIssues] = useState(flow?.queueIssues ?? true);
  const [autoApplyTriage, setAutoApplyTriage] = useState(flow?.autoApplyTriage ?? true);
  const [mergeMethod, setMergeMethod] = useState<ContributorFlowPolicy['mergeMethod']>(flow?.mergeMethod ?? 'squash');
  const [maxAttempts, setMaxAttempts] = useState(flow?.maxAttempts ?? 3);
  const [dryRunOpen, setDryRunOpen] = useState(false);
  const [dryRunBusy, setDryRunBusy] = useState(false);
  const [dryRunError, setDryRunError] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState<ContributorFlowDryRun | null>(null);

  useEffect(() => {
    setMode(flow?.mode ?? 'off');
    setKinds([...(flow?.actionableIssueKinds ?? DEFAULT_ACTIONABLE_KINDS)]);
    setQueueIssues(flow?.queueIssues ?? true);
    setAutoApplyTriage(flow?.autoApplyTriage ?? true);
    setMergeMethod(flow?.mergeMethod ?? 'squash');
    setMaxAttempts(flow?.maxAttempts ?? 3);
  }, [flow]);

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      if (mode !== 'off' && !repo.webhookConfigured) {
        if (!webhookAccountId) {
          throw new Error('Connect a GitHub account with webhook access before enabling the contributor flow.');
        }
        onWebhookChange(await api.enableWebhook(repo.fullName, webhookAccountId));
      }
      await api.setContributorFlow(workspaceId, repo.fullName, {
        mode,
        actionableIssueKinds: kinds,
        queueIssues,
        autoApplyTriage,
        mergeMethod,
        maxAttempts,
      });
      await onChanged();
    } catch (err) {
      onError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleKind = (kind: ActionableIssueKind): void => {
    setKinds((current) => current.includes(kind) ? current.filter((item) => item !== kind) : [...current, kind]);
  };

  const preview = async (): Promise<void> => {
    if (mode === 'off') return;
    setDryRunOpen(true);
    setDryRunBusy(true);
    setDryRunError(null);
    try {
      const result = await api.dryRunContributorFlow(workspaceId, repo.fullName, { mode, mergeMethod });
      setDryRun(result.report);
    } catch (err) {
      setDryRunError(String(err));
    } finally {
      setDryRunBusy(false);
    }
  };

  const dirty =
    mode !== (flow?.mode ?? 'off') ||
    queueIssues !== (flow?.queueIssues ?? true) ||
    autoApplyTriage !== (flow?.autoApplyTriage ?? true) ||
    mergeMethod !== (flow?.mergeMethod ?? 'squash') ||
    maxAttempts !== (flow?.maxAttempts ?? 3) ||
    [...kinds].sort().join(',') !== [...(flow?.actionableIssueKinds ?? DEFAULT_ACTIONABLE_KINDS)].sort().join(',');

  return (
    <div className="mt-3 rounded-lg border border-emerald-500/25 bg-emerald-500/[0.035] p-3.5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <Eyebrow>Contributor lifecycle</Eyebrow>
          <p className="mt-1 text-sm font-medium">Issue → implementation → review → CI repair → merge</p>
          <p className="dim mt-1 text-xs leading-relaxed">
            Uses durable webhook work and the Task Board reconciler. Every agent change is isolated, verified, reviewed
            at its exact head, and bounded by the attempt and instance budget ceilings.
          </p>
        </div>
        <select
          className="input input-sm"
          value={mode}
          disabled={busy}
          aria-label={`Contributor flow mode for ${repo.fullName}`}
          onChange={(event) => setMode(event.target.value as ContributorFlowMode)}
        >
          <option value="off">Off</option>
          <option value="governed" disabled={!boardEnabled}>Governed · human merge</option>
          <option value="autonomous" disabled={!boardEnabled}>Autonomous · policy merge</option>
        </select>
      </div>

      {!boardEnabled ? (
        <div className="banner-warn mb-0 mt-3 text-xs">
          The Task Board module is disabled, so end-to-end contributor work is paused. Enable it from{' '}
          <a className="link" href="#/modules">Modules</a>; triage and standalone pipelines remain available.
        </div>
      ) : null}

      {missingPermissions.length > 0 && mode !== 'off' ? (
        <div className="banner-warn mb-0 mt-3 text-xs">
          This flow is paused for your profile because its role is missing {missingPermissions.join(', ')}. You can
          still turn it off; an administrator must restore the complete bundle before it can be saved active.
        </div>
      ) : null}

      {!githubAccessible && mode !== 'off' ? (
        <div className="banner-warn mb-0 mt-3 text-xs">
          Connect one of your own GitHub accounts with repository access before taking over or enabling this flow.
        </div>
      ) : null}

      {mode !== 'off' ? (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-1 text-[11px]" aria-label="Contributor flow stages">
            {['Triage', queueIssues ? 'Queue' : 'Backlog', 'Build', 'Auto-review', 'Repair CI', mode === 'autonomous' ? 'Merge' : 'Human decision'].map((stage, index) => (
              <span key={stage} className="contents">
                {index > 0 ? <span className="dim">→</span> : null}
                <span className="badge normal-case">{stage}</span>
              </span>
            ))}
          </div>
          {!repo.webhookConfigured ? (
            <div className="banner-warn mb-0 mt-3 text-xs">
              Enable the GitHub webhook below before relying on this flow; polling alone cannot guarantee immediate admission.
            </div>
          ) : null}
          {repo.webhookConfigured && webhook && !webhook.remoteId ? (
            <div className="banner-warn mb-0 mt-3 text-xs">
              The local receiver is ready, but Companion has not confirmed a GitHub-side hook. Repair it below or
              finish the manual setup before relying on immediate admission.
            </div>
          ) : null}
          <details className="mt-3 border-t border-emerald-500/15 pt-3">
            <summary className="cursor-pointer text-xs font-medium select-none">Policy details</summary>
            <div className="mt-3 flex flex-col gap-3">
              <div>
                <div className="text-xs font-medium">Issue kinds admitted to implementation</div>
                <p className="dim mt-0.5 text-[11px]">Duplicates, questions, invalid reports, and reports needing information always stop after triage.</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {(['bug', 'feature', 'docs', 'chore'] as const).map((kind) => (
                    <label key={kind} className="flex items-center gap-1.5 text-xs">
                      <input type="checkbox" checked={kinds.includes(kind)} onChange={() => toggleKind(kind)} />
                      {kind}
                    </label>
                  ))}
                </div>
              </div>
              <SettingRow title="Start implementation immediately" description="Off creates a reviewed board backlog item instead of spending a runner slot.">
                <Switch checked={queueIssues} label="Queue actionable issues" onChange={setQueueIssues} />
              </SettingRow>
              <SettingRow title="Apply triage labels" description="Applies labels only; draft prose stays pending for a maintainer.">
                <Switch checked={autoApplyTriage} label="Apply triage labels" onChange={setAutoApplyTriage} />
              </SettingRow>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-xs">
                  <span className="font-medium">Merge method</span>
                  <select className="input input-sm" value={mergeMethod} onChange={(event) => setMergeMethod(event.target.value as ContributorFlowPolicy['mergeMethod'])}>
                    <option value="squash">Squash</option>
                    <option value="merge">Merge commit</option>
                    <option value="rebase">Rebase</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  <span className="font-medium">Remediation ceiling</span>
                  <input className="input input-sm" type="number" min={1} max={10} value={maxAttempts} onChange={(event) => setMaxAttempts(Math.min(10, Math.max(1, Number(event.target.value) || 1)))} />
                </label>
              </div>
            </div>
          </details>
        </>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-emerald-500/15 pt-3">
        <button
          className="btn-ghost"
          disabled={
            busy ||
            dryRunBusy ||
            mode === 'off' ||
            !githubAccessible ||
            missingPermissions.includes('issues:read') ||
            missingPermissions.includes('prs:read')
          }
          title={mode === 'off' ? 'Choose Governed or Autonomous to simulate that policy.' : 'Read-only: starts no agents and writes nothing to GitHub.'}
          onClick={() => void preview()}
        >
          {dryRunBusy ? 'Inspecting live backlog…' : 'Dry-run current backlog'}
        </button>
        <button
          className="btn"
          disabled={
            busy ||
            !dirty ||
            (mode !== 'off' && (!boardEnabled || !githubAccessible || missingPermissions.length > 0))
          }
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : mode === 'off' ? 'Disable flow' : 'Save contributor flow'}
        </button>
      </div>

      {dryRunOpen ? (
        <ContributorFlowDryRunModal
          report={dryRun}
          loading={dryRunBusy}
          error={dryRunError}
          onRetry={() => void preview()}
          onClose={() => setDryRunOpen(false)}
        />
      ) : null}
    </div>
  );
}

function ContributorFlowDryRunModal({
  report,
  loading,
  error,
  onRetry,
  onClose,
}: {
  report: ContributorFlowDryRun | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <Modal title="Contributor lifecycle dry run" onClose={onClose} xl>
      {loading && report === null ? (
        <div className="flex flex-col gap-3" aria-label="Inspecting repository backlog">
          <div className="banner-info mb-0 text-xs">Reading live GitHub metadata, branch protection and a bounded PR workload. No agent or pipeline is running.</div>
          <Skeleton className="block h-20 w-full" />
          <Skeleton className="block h-36 w-full" />
          <Skeleton className="block h-48 w-full" />
        </div>
      ) : null}
      <ErrorBar error={error} />
      {error && !loading ? (
        <button className="btn mt-3" onClick={onRetry}>Retry dry run</button>
      ) : null}
      {report ? (
        <div className={loading ? 'opacity-60' : ''} aria-busy={loading}>
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <strong>{report.repo}</strong>
                <MetaSignal
                  tone={report.status === 'ready' ? 'green' : report.status === 'attention' ? 'amber' : 'red'}
                  label={report.status}
                />
                <MetaSignal tone="blue" label={`${report.mode} simulation`} />
              </div>
              <p className="dim mt-1 text-xs">
                Observed {timeAgo(report.observedAt)} · exactly {report.githubMutations} GitHub writes · exactly {report.agentRuns} agent runs
              </p>
            </div>
            <button className="btn-ghost" disabled={loading} onClick={onRetry}>
              {loading ? 'Refreshing…' : 'Refresh live evidence'}
            </button>
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <DryRunMetric label="Open PRs" value={report.workload.openPulls} detail={`${report.workload.drafts} drafts`} />
            <DryRunMetric label="Known changed lines" value={report.workload.knownChangedLines} detail={`median ${report.workload.medianChangedLines?.toLocaleString() ?? 'unknown'}`} />
            <DryRunMetric label="Large review" value={report.workload.atLeastOneThousandLines} detail={`${report.workload.atLeastFiftyFiles} touch 50+ files`} />
            <DryRunMetric label="Open issues" value={report.workload.openIssues} detail={`${report.workload.unlabelledIssues} unlabelled`} />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
            <section>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Readiness evidence</div>
              <ListCard>
                {report.checks.map((item) => (
                  <div key={item.id} className="flex items-start gap-2.5 px-3.5 py-2.5">
                    <MetaSignal
                      tone={item.status === 'pass' ? 'green' : item.status === 'warning' ? 'amber' : 'red'}
                      label={item.status}
                    />
                    <div className="min-w-0">
                      <div className="text-xs font-medium">{item.label}</div>
                      <p className="dim mt-0.5 text-[11px] leading-relaxed">{item.detail}</p>
                    </div>
                  </div>
                ))}
              </ListCard>
            </section>
            <section>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Proposed admission lanes</div>
              <ListCard>
                {([
                  ['Wait for author', report.workload.lanes.waitForAuthor, 'Drafts spend no reviewer capacity.'],
                  ['Repair first', report.workload.lanes.repairFirst, 'Resolve conflicts or failing CI before review.'],
                  ['Map and split', report.workload.lanes.mapAndSplit, 'Guidance only until bounded slices cover the change.'],
                  ['Bounded review', report.workload.lanes.boundedReview, 'Review independent slices with explicit coverage.'],
                  ['Standard review', report.workload.lanes.standardReview, 'Normal head-pinned review path.'],
                  ['Final evidence gate', report.workload.lanes.evidenceGate, 'Revalidate complete evidence immediately before merge.'],
                ] as const).map(([label, count, detail]) => (
                  <div key={label} className="flex items-center gap-3 px-3.5 py-2.5">
                    <span className="w-8 text-right font-mono text-sm tabular-nums">{count}</span>
                    <div className="min-w-0">
                      <div className="text-xs font-medium">{label}</div>
                      <p className="dim mt-0.5 text-[11px]">{detail}</p>
                    </div>
                  </div>
                ))}
              </ListCard>
              <div className="banner-info mb-0 mt-3 text-[11px] leading-relaxed">
                {report.workload.agentAuthored} PR(s) disclose <code className="code-inline">agent-authored</code> provenance. This count never selects a lane or quality verdict.
              </div>
              {report.rateLimit ? (
                <p className="dim mt-2 text-[11px]">
                  GitHub {report.rateLimit.resource ?? 'API'} budget: {report.rateLimit.remaining ?? 'unknown'}{report.rateLimit.limit === null ? '' : ` / ${report.rateLimit.limit}`} remaining.
                </p>
              ) : null}
            </section>
          </div>

          <details className="mt-4 rounded-lg border border-zinc-200 dark:border-zinc-800">
            <summary className="cursor-pointer px-3.5 py-3 text-xs font-medium select-none">
              Inspect {report.pulls.length} measured PR decision(s)
            </summary>
            <div className="max-h-[28rem] overflow-y-auto border-t border-zinc-200 dark:border-zinc-800">
              {report.pulls.map((pull) => (
                <div key={pull.number} className="flex flex-wrap items-start gap-2 border-b border-zinc-200 px-3.5 py-2.5 last:border-b-0 dark:border-zinc-800">
                  <span className="badge">#{pull.number}</span>
                  <div className="min-w-0 flex-1">
                    <a className="link text-xs font-medium" href={pull.url} target="_blank" rel="noreferrer">{pull.title}</a>
                    <p className="dim mt-0.5 text-[11px]">
                      {pull.author} · {pull.changedLines?.toLocaleString() ?? 'unknown'} lines · {pull.changedFiles ?? 'unknown'} files · {pull.reasons.join(' · ')}
                    </p>
                  </div>
                  <MetaSignal tone={pull.lane === 'repair-first' || pull.lane === 'map-and-split' ? 'amber' : 'zinc'} label={dryRunLaneLabel(pull.lane)} />
                </div>
              ))}
            </div>
          </details>
          {!report.source.pullListComplete || !report.source.issueListComplete || !report.source.pullDetailsComplete ? (
            <div className="banner-warn mb-0 mt-3 text-xs">
              Measurement is incomplete. Companion reports this dry run as blocked and will not turn partial evidence into an autonomous decision.
            </div>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}

function DryRunMetric({ label, value, detail }: { label: string; value: number; detail: string }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="dim text-[11px]">{label}</div>
      <div className="mt-1 font-mono text-lg tabular-nums">{value.toLocaleString()}</div>
      <div className="dim mt-0.5 text-[11px]">{detail}</div>
    </div>
  );
}

function dryRunLaneLabel(lane: ContributorFlowDryRun['pulls'][number]['lane']): string {
  switch (lane) {
    case 'wait-for-author': return 'wait';
    case 'repair-first': return 'repair';
    case 'map-and-split': return 'map/split';
    case 'bounded-review': return 'bounded review';
    case 'standard-review': return 'review';
    case 'evidence-gate': return 'evidence gate';
  }
}

/**
 * One click from "repo connected" to a working configuration.
 *
 * The switches below and the pipeline editor were both already here, so this adds
 * no capability. What it adds is a starting point: every automation was off by
 * default and a slop screen needed a pipeline assembled by hand, which put the
 * most valuable part of the product behind knowing the model first.
 *
 * The catalogue is fetched rather than hardcoded, so what a card promises is what
 * the server writes, and the outcome is reported rather than assumed: a preset
 * that could not create its pipeline must say so.
 */
function PresetPicker({
  repo,
  busy,
  canEnable,
  onApplied,
  onError,
  setBusy,
}: {
  repo: string;
  busy: boolean;
  canEnable: boolean;
  onApplied: () => Promise<void> | void;
  onError: (message: string) => void;
  setBusy: (busy: boolean) => void;
}): React.JSX.Element | null {
  const [presets, setPresets] = useState<RepoPreset[] | null>(null);
  const [applied, setApplied] = useState<RepoPresetResult | null>(null);

  useEffect(() => {
    void api
      .repoPresets()
      .then(({ presets: rows }) => setPresets(rows))
      // A missing catalogue hides the picker; the switches below still work, so
      // this is not worth a banner.
      .catch(() => setPresets([]));
  }, []);

  if (presets === null || presets.length === 0) return null;

  const apply = async (id: RepoPresetId): Promise<void> => {
    setBusy(true);
    setApplied(null);
    try {
      const { result } = await api.applyPreset(repo, id);
      setApplied(result);
      await onApplied();
    } catch (err) {
      onError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3">
      <Eyebrow>Start from a preset</Eyebrow>
      <p className="dim mt-1 text-xs">Sets the switches below and creates a pipeline. Everything stays editable.</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        {presets.map((preset) => (
          <button
            key={preset.id}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-left transition-colors hover:border-zinc-400 disabled:opacity-60 dark:border-zinc-800 dark:hover:border-zinc-600"
            disabled={busy || (preset.id !== 'watch' && !canEnable)}
            title={preset.id !== 'watch' && !canEnable ? 'Connect one of your GitHub accounts before enabling this preset.' : undefined}
            onClick={() => void apply(preset.id)}
          >
            <span className="text-[13px] font-medium">{preset.label}</span>
            <span className="dim mt-0.5 block text-xs">{preset.description}</span>
          </button>
        ))}
      </div>
      {applied ? <PresetOutcome result={applied} /> : null}
    </div>
  );
}

/** What actually happened, in the words of the server rather than the button. */
function PresetOutcome({ result }: { result: RepoPresetResult }): React.JSX.Element {
  const notes: string[] = [];
  if (result.skippedSteps.includes('slop-check')) {
    notes.push('The slop screen was left out because Slop Detection is not enabled on this instance.');
  }
  if (result.pipelineSkipped === 'not-permitted') {
    notes.push('The switches were applied, but your role may not create pipelines, so none was created.');
  }
  if (result.pipelineSkipped === 'no-steps-left') {
    notes.push('No pipeline was created: every step this preset defines needs a module that is not enabled here.');
  }
  if (result.pipelineSkipped === 'account-unavailable') {
    notes.push('No pipeline was created: connect one of your GitHub accounts for pipeline work on this repository.');
  }
  return (
    <div className="banner-info mt-2 text-xs" role="status">
      Applied. {result.pipelineId ? 'A pull-request pipeline was created. ' : ''}
      {notes.join(' ')}
    </div>
  );
}
