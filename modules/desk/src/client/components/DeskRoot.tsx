import { useEffect, useMemo, useRef, useState } from 'react';
import { ErrorBar } from '@moxxy/companion-sdk/ui';
import type { RepoRecord } from '@companion/module-code/contract';
import { codeApi } from '@companion/module-code/client';
import { useAuth } from '@companion/module-core/client';
import { useLane } from '@companion/module-operate/client';
import type { NotificationRecord } from '@companion/module-workspace/contract';
import { useNotifications, useWorkspace } from '@companion/module-workspace/client';
import type { DeskContextRef, DeskMissionView } from '../../contract/index.js';
import { deskApi } from '../api.js';
import { useDeskOverview } from '../hooks/useDeskOverview.js';
import { useMissions } from '../hooks/useMissions.js';
import { ActivityPage } from './ActivityPage.js';
import { ContextPreview } from './ContextPreview.js';
import { ContextShelf } from './ContextShelf.js';
import { DeskHeader, type DeskSection } from './DeskHeader.js';
import { MissionChat } from './MissionChat.js';
import { MissionsOverview } from './MissionsOverview.js';
import { OverviewPage } from './OverviewPage.js';

type DeskRoute =
  | { readonly kind: 'overview' }
  | { readonly kind: 'activity' }
  | { readonly kind: 'missions' }
  | { readonly kind: 'mission'; readonly id: string }
  | { readonly kind: 'context'; readonly context: DeskContextRef };

export function DeskRoot(): React.JSX.Element {
  const auth = useAuth();
  const workspace = useWorkspace();
  const lane = useLane();
  const missions = useMissions();
  const notifications = useNotifications();
  const route = useDeskRoute();
  const [repos, setRepos] = useState<readonly RepoRecord[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [reposLoading, setReposLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const overview = useDeskOverview(workspace.current?.id, selectedRepo);

  const active = useMemo(
    () => route.kind === 'mission'
      ? missions.missions.find((entry) => entry.mission.id === route.id) ?? null
      : null,
    [missions.missions, route],
  );

  useEffect(() => {
    document.title = `Desk · ${auth.branding.name?.trim() || 'Companion'}`;
  }, [auth.branding.name]);

  // A local daemon restart can happen while the SPA remains mounted. Refresh
  // on the mission boundaries so a boot-recovered run cannot show one status
  // in the list and another in the conversation header.
  useEffect(() => {
    if (route.kind === 'mission' || route.kind === 'missions') void missions.refresh();
  }, [missions.refresh, route.kind]);

  useEffect(() => {
    if (!active) return;
    if (workspace.current?.id !== active.mission.workspaceId) {
      workspace.setCurrent(active.mission.workspaceId, { navigate: false });
    }
    setSelectedRepo(active.mission.repo);
  }, [active, workspace]);

  useEffect(() => {
    const current = workspace.current;
    if (!current) {
      setRepos([]);
      setSelectedRepo(null);
      return;
    }
    let alive = true;
    setReposLoading(true);
    void codeApi.workspaceRepos(current.id).then(({ repos: next }) => {
      if (!alive) return;
      setRepos(next);
      setSelectedRepo((selected) => selected === null || next.some((repo) => repo.fullName === selected)
        ? selected
        : null);
    }).catch((err) => {
      if (alive) setError(err instanceof Error ? err.message : String(err));
    }).finally(() => {
      if (alive) setReposLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [workspace.current]);

  const chooseSection = (section: DeskSection): void => {
    setError(null);
    setSearch('');
    navigate(
      section === 'overview'
        ? { kind: 'overview' }
        : section === 'activity'
          ? { kind: 'activity' }
          : { kind: 'missions' },
    );
  };

  const chooseMission = (view: DeskMissionView, preserveError = false): void => {
    if (!preserveError) setError(null);
    if (workspace.current?.id !== view.mission.workspaceId) {
      workspace.setCurrent(view.mission.workspaceId, { navigate: false });
    }
    setSelectedRepo(view.mission.repo);
    setSearch('');
    navigate({ kind: 'mission', id: view.mission.id });
  };

  const createMission = async (opts?: {
    readonly title?: string;
    readonly context?: DeskContextRef;
  }): Promise<DeskMissionView> => {
    if (!workspace.current) throw new Error('Choose a workspace first');
    if (creatingRef.current) throw new Error('A mission is already being created');
    creatingRef.current = true;
    setCreating(true);
    setError(null);
    try {
      const view = await deskApi.createMission({
        ...(opts?.title ? { title: opts.title } : {}),
        workspaceId: workspace.current.id,
        repo: opts?.context?.repo ?? selectedRepo,
        runnerId: lane.lane?.runnerId ?? null,
        harness: lane.lane?.harness ?? null,
        ...(opts?.context ? { contexts: [opts.context] } : {}),
      });
      await missions.refresh();
      return view;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const newMission = async (): Promise<void> => {
    try {
      chooseMission(await createMission());
    } catch {
      // The persistent error bar owns the failure.
    }
  };

  const startContextMission = async (context: DeskContextRef, title: string, prompt: string): Promise<void> => {
    const view = await createMission({ title, context });
    try {
      await deskApi.ensureSession(view.mission.id);
      await deskApi.sendMessage(view.mission.id, prompt);
      await missions.refresh();
      chooseMission(view);
    } catch (err) {
      // Mission creation is durable even when every runner is busy. Open the
      // draft instead of stranding it behind an error on the context page.
      setError(err instanceof Error ? err.message : String(err));
      chooseMission(view, true);
    }
  };

  const switchWorkspace = (id: string): void => {
    setError(null);
    workspace.setCurrent(id, { navigate: false });
    setSelectedRepo(null);
    setSearch('');
    navigate({ kind: 'overview' });
  };

  const archiveMission = async (view: DeskMissionView): Promise<void> => {
    if (archivingId) return;
    setArchivingId(view.mission.id);
    setError(null);
    try {
      await deskApi.updateMission(view.mission.id, { archived: true });
      await missions.refresh();
      if (route.kind === 'mission' && route.id === view.mission.id) navigate({ kind: 'missions' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setArchivingId(null);
    }
  };

  const section: DeskSection = route.kind === 'overview' || route.kind === 'context'
    ? 'overview'
    : route.kind === 'activity'
      ? 'activity'
      : 'missions';

  const openNotification = (notification: NotificationRecord): void => {
    notifications.markRead(notification.id);
    const deskRoute = notificationRoute(notification.href, missions.missions);
    if (deskRoute) navigate(deskRoute);
    else if (notification.href) location.assign(`/${notification.href}`);
  };

  return (
    <div className="flex h-full min-w-[48rem] flex-col overflow-hidden bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <DeskHeader
        section={section}
        missionCount={missions.missions.length}
        activityCount={notifications.unread}
        prs={overview.prs}
        issues={overview.issues}
        searchLoading={overview.loading}
        searchError={overview.error}
        searchScope={selectedRepo ?? workspace.current?.name ?? 'Current workspace'}
        onOpenContext={(context) => { setError(null); navigate({ kind: 'context', context }); }}
        onNavigate={chooseSection}
        onNewMission={() => void newMission()}
        creating={creating}
        canCreate={workspace.current !== null}
      />
      {error ? <ErrorBar error={error} className="mx-6 mt-3" /> : null}

      {route.kind === 'overview' ? (
        <OverviewPage
          workspace={workspace.current}
          workspaces={workspace.workspaces}
          repos={repos}
          repo={selectedRepo}
          reposLoading={reposLoading}
          feed={overview}
          missions={missions.missions}
          search={search}
          onSearch={setSearch}
          onWorkspaceChange={switchWorkspace}
          onRepoChange={setSelectedRepo}
          onOpenContext={(context) => { setError(null); navigate({ kind: 'context', context }); }}
          onOpenMission={chooseMission}
        />
      ) : route.kind === 'activity' ? (
        <ActivityPage
          items={notifications.items}
          unread={notifications.unread}
          loading={notifications.loading}
          error={notifications.error}
          hasMore={notifications.hasMore}
          onOpen={openNotification}
          onMarkAllRead={notifications.markAllRead}
          onLoadMore={notifications.loadMore}
        />
      ) : route.kind === 'missions' ? (
        <MissionsOverview
          missions={missions.missions}
          loading={missions.loading}
          error={missions.error}
          prs={overview.prs}
          issues={overview.issues}
          repos={repos}
          repo={selectedRepo}
          search={search}
          onSearch={setSearch}
          onRepoChange={setSelectedRepo}
          onOpen={chooseMission}
          onArchive={(view) => void archiveMission(view)}
          archivingId={archivingId}
        />
      ) : route.kind === 'context' ? (
        <ContextPreview
          key={contextKey(route.context)}
          context={route.context}
          missions={missions.missions}
          onBack={() => { setError(null); navigate({ kind: 'overview' }); }}
          onOpenMission={chooseMission}
          onStartMission={(title, prompt) => startContextMission(route.context, title, prompt)}
        />
      ) : (
        <div className="flex min-h-0 flex-1 bg-[#fcfcfb] p-6 dark:bg-zinc-950">
          <div className="mx-auto flex min-h-0 w-full max-w-[96rem] overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
            <MissionChat view={active} loading={missions.loading} onBack={() => navigate({ kind: 'missions' })} />
            <ContextShelf view={active} onUpdated={async () => { await missions.refresh(); }} />
          </div>
        </div>
      )}
    </div>
  );
}

function useDeskRoute(): DeskRoute {
  const [route, setRoute] = useState<DeskRoute>(() => parseRoute(location.hash));
  useEffect(() => {
    if (!location.hash) history.replaceState(null, '', '#/overview');
    const onChange = (): void => setRoute(parseRoute(location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

function parseRoute(hash: string): DeskRoute {
  const path = hash.replace(/^#\/?/, '').split('?')[0] ?? '';
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'missions' && parts[1]) return { kind: 'mission', id: decodeRoutePart(parts[1]) };
  if (parts[0] === 'missions') return { kind: 'missions' };
  if (parts[0] === 'activity' || parts[0] === 'inbox') return { kind: 'activity' };
  if ((parts[0] === 'pull-request' || parts[0] === 'issue') && parts[1] && parts[2]) {
    const number = Number(parts[2]);
    if (Number.isInteger(number) && number > 0) {
      return {
        kind: 'context',
        context: {
          kind: parts[0] === 'pull-request' ? 'pull-request' : 'issue',
          repo: decodeRoutePart(parts[1]),
          number,
        },
      };
    }
  }
  return { kind: 'overview' };
}

function decodeRoutePart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function contextKey(context: DeskContextRef): string {
  return `${context.kind}:${context.repo}#${context.number}`;
}

function navigate(route: DeskRoute): void {
  if (route.kind === 'overview') location.hash = '#/overview';
  else if (route.kind === 'activity') location.hash = '#/activity';
  else if (route.kind === 'missions') location.hash = '#/missions';
  else if (route.kind === 'mission') location.hash = `#/missions/${encodeURIComponent(route.id)}`;
  else location.hash = `#/${route.context.kind}/${encodeURIComponent(route.context.repo)}/${route.context.number}`;
}

function notificationRoute(href: string | null, missions: readonly DeskMissionView[]): DeskRoute | null {
  if (!href) return null;
  const run = /^#\/runs\/([^/?]+)/.exec(href);
  if (run?.[1]) {
    const runId = decodeRoutePart(run[1]);
    const mission = missions.find((entry) => entry.mission.runId === runId);
    if (mission) return { kind: 'mission', id: mission.mission.id };
  }
  const pr = /^#\/repos\/(.+)\/prs\/(\d+)/.exec(href);
  if (pr?.[1] && pr[2]) {
    return { kind: 'context', context: { kind: 'pull-request', repo: decodeRoutePart(pr[1]), number: Number(pr[2]) } };
  }
  const issue = /^#\/repos\/(.+)\/issues\/(\d+)/.exec(href);
  if (issue?.[1] && issue[2]) {
    return { kind: 'context', context: { kind: 'issue', repo: decodeRoutePart(issue[1]), number: Number(issue[2]) } };
  }
  return null;
}
