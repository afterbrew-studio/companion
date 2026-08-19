import { useEffect, useMemo, useState } from 'react';
import {
  BrandTile,
  CloseIcon,
  Dropdown,
  ErrorBar,
  PlusIcon,
  Spinner,
  StatusDot,
} from '@moxxy/companion-sdk/ui';
import type { RepoRecord } from '@companion/module-code/contract';
import { codeApi } from '@companion/module-code/client';
import { useAuth } from '@companion/module-core/client';
import { useLane } from '@companion/module-operate/client';
import { useWorkspace } from '@companion/module-workspace/client';
import type { DeskMissionView } from '../../contract/index.js';
import { deskApi } from '../api.js';
import { useMissions } from '../hooks/useMissions.js';
import { missionStatus } from '../status.js';
import { ContextShelf } from './ContextShelf.js';
import { MissionChat } from './MissionChat.js';

const ACTIVE_MISSION_KEY = 'companion.desk.mission';
const ALL_REPOS = '__all_repositories__';

export function DeskRoot(): React.JSX.Element {
  const auth = useAuth();
  const workspace = useWorkspace();
  const lane = useLane();
  const feed = useMissions();
  const [activeId, setActiveId] = useState<string | null>(() => localStorage.getItem(ACTIVE_MISSION_KEY));
  const [repos, setRepos] = useState<readonly RepoRecord[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string>(ALL_REPOS);
  const [reposLoading, setReposLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [scopingNewMission, setScopingNewMission] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = useMemo(
    () => feed.missions.find((entry) => entry.mission.id === activeId) ?? null,
    [activeId, feed.missions],
  );

  useEffect(() => {
    if (feed.loading) return;
    if (scopingNewMission) return;
    if (activeId && feed.missions.some((entry) => entry.mission.id === activeId)) return;
    const next = feed.missions[0]?.mission.id ?? null;
    setActiveId(next);
    if (next) localStorage.setItem(ACTIVE_MISSION_KEY, next);
    else localStorage.removeItem(ACTIVE_MISSION_KEY);
  }, [activeId, feed.loading, feed.missions, scopingNewMission]);

  useEffect(() => {
    if (!active) return;
    if (workspace.current?.id !== active.mission.workspaceId) {
      workspace.setCurrent(active.mission.workspaceId, { navigate: false });
    }
    setSelectedRepo(active.mission.repo ?? ALL_REPOS);
  }, [active, workspace]);

  useEffect(() => {
    const current = workspace.current;
    if (!current) {
      setRepos([]);
      setSelectedRepo(ALL_REPOS);
      return;
    }
    let alive = true;
    setReposLoading(true);
    void codeApi.workspaceRepos(current.id).then(({ repos: next }) => {
      if (!alive) return;
      setRepos(next);
      setSelectedRepo((selected) => selected === ALL_REPOS || next.some((repo) => repo.fullName === selected)
        ? selected
        : ALL_REPOS);
    }).catch((err) => {
      if (alive) setError(err instanceof Error ? err.message : String(err));
    }).finally(() => {
      if (alive) setReposLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [workspace.current]);

  useEffect(() => {
    document.title = `Desk · ${auth.branding.name?.trim() || 'Companion'}`;
  }, [auth.branding.name]);

  const chooseMission = (view: DeskMissionView): void => {
    setActiveId(view.mission.id);
    setScopingNewMission(false);
    localStorage.setItem(ACTIVE_MISSION_KEY, view.mission.id);
    setSelectedRepo(view.mission.repo ?? ALL_REPOS);
    if (workspace.current?.id !== view.mission.workspaceId) {
      workspace.setCurrent(view.mission.workspaceId, { navigate: false });
    }
  };

  const createMission = async (): Promise<void> => {
    if (!workspace.current || creating) return;
    setCreating(true);
    setError(null);
    try {
      const view = await deskApi.createMission({
        workspaceId: workspace.current.id,
        repo: selectedRepo === ALL_REPOS ? null : selectedRepo,
        runnerId: lane.lane?.runnerId ?? null,
        harness: lane.lane?.harness ?? null,
      });
      await feed.refresh();
      chooseMission(view);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const switchWorkspace = (id: string): void => {
    workspace.setCurrent(id, { navigate: false });
    setScopingNewMission(true);
    setActiveId(null);
    localStorage.removeItem(ACTIVE_MISSION_KEY);
    setSelectedRepo(ALL_REPOS);
  };

  const switchRepo = (repo: string): void => {
    setScopingNewMission(true);
    setSelectedRepo(repo);
    setActiveId(null);
    localStorage.removeItem(ACTIVE_MISSION_KEY);
  };

  const archiveMission = async (view: DeskMissionView): Promise<void> => {
    if (archivingId) return;
    setArchivingId(view.mission.id);
    setError(null);
    try {
      await deskApi.updateMission(view.mission.id, { archived: true });
      if (activeId === view.mission.id) {
        setActiveId(null);
        localStorage.removeItem(ACTIVE_MISSION_KEY);
      }
      await feed.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setArchivingId(null);
    }
  };

  const workspaceOptions = workspace.workspaces.map((entry) => ({
    value: entry.id,
    label: entry.name,
    hint: `${entry.repoCount} ${entry.repoCount === 1 ? 'repo' : 'repos'}`,
  }));
  const repoOptions = [
    { value: ALL_REPOS, label: 'All repositories', hint: 'Workspace scope' },
    ...repos.map((repo) => ({
      value: repo.fullName,
      label: repo.fullName,
      hint: repo.githubAccessible ? repo.defaultBranch : 'Unavailable',
      disabled: !repo.githubAccessible,
    })),
  ];

  return (
    <div className="flex h-full min-w-[48rem] flex-col overflow-hidden bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-zinc-200 px-3 dark:border-zinc-800">
        <a href="/desk/" className="flex shrink-0 items-center gap-2 px-1" aria-label="Companion Desk home">
          {auth.branding.logo ? (
            <img src={auth.branding.logo} alt="" className="size-7 rounded-lg object-cover" />
          ) : (
            <BrandTile />
          )}
          <span className="text-sm font-semibold">Desk</span>
        </a>
        <span className="h-5 w-px bg-zinc-200 dark:bg-zinc-800" />
        <Dropdown
          value={workspace.current?.id ?? null}
          onChange={switchWorkspace}
          options={workspaceOptions}
          ariaLabel="Workspace"
          placeholder="Choose workspace"
          searchable={workspaceOptions.length > 7}
          triggerClassName="flex h-9 min-w-40 max-w-56 items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 text-left text-xs transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
        />
        <span className="dim">/</span>
        <Dropdown
          value={selectedRepo}
          onChange={switchRepo}
          options={repoOptions}
          ariaLabel="Repository"
          placeholder={reposLoading ? 'Loading…' : 'Choose repository'}
          disabled={!workspace.current || reposLoading}
          searchable={repoOptions.length > 7}
          maxVisible={80}
          action={{
            label: 'Manage repositories in Companion',
            icon: <PlusIcon className="size-3.5" />,
            onSelect: () => { location.href = '/#/repos'; },
          }}
          triggerClassName="flex h-9 min-w-48 max-w-72 items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 text-left text-xs transition-colors hover:border-zinc-300 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
        />
        <button type="button" className="btn h-9 shrink-0" disabled={!workspace.current || creating} onClick={() => void createMission()}>
          {creating ? <Spinner /> : <PlusIcon className="size-3.5" />}
          New mission
        </button>
        <div className="flex-1" />
        <a href="/" className="btn-ghost h-8 shrink-0 text-xs">Full Companion</a>
        <div className="hidden min-w-0 text-right sm:block">
          <div className="max-w-36 truncate text-xs font-medium">{auth.user?.displayName || auth.user?.username}</div>
          <button type="button" className="dim block max-w-36 cursor-pointer truncate text-[10px] hover:text-zinc-900 dark:hover:text-zinc-100" onClick={() => void auth.logout()}>
            Sign out
          </button>
        </div>
      </header>

      <div className="flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b border-zinc-200 bg-zinc-50/70 px-3 dark:border-zinc-800 dark:bg-zinc-900/40" aria-label="Missions">
        <span className="dim mr-1 shrink-0 text-[10px] font-medium tracking-wide uppercase">Missions</span>
        {feed.loading ? <Spinner /> : feed.missions.length === 0 ? (
          <span className="dim text-xs">No missions yet</span>
        ) : feed.missions.map((entry) => {
          const status = missionStatus(entry);
          const selected = entry.mission.id === active?.mission.id;
          return (
            <div
              key={entry.mission.id}
              className={`group flex h-8 max-w-64 shrink-0 items-center rounded-lg border text-xs transition-colors ${selected
                ? 'border-zinc-300 bg-white text-zinc-900 shadow-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100'
                : 'border-transparent text-zinc-500 hover:border-zinc-200 hover:bg-white/70 hover:text-zinc-900 dark:text-zinc-400 dark:hover:border-zinc-800 dark:hover:bg-zinc-900 dark:hover:text-zinc-100'}`}
              title={`${entry.mission.title} · ${status.label}`}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5 pl-2.5"
                onClick={() => chooseMission(entry)}
              >
                <StatusDot tone={status.tone} pulse={status.pulse} size="sm" label={status.label} />
                <span className="truncate">{entry.mission.title}</span>
                {entry.pendingAsks.length > 0 ? <span className="badge-warn">{entry.pendingAsks.length}</span> : null}
              </button>
              <button
                type="button"
                className="dim mr-1 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md opacity-0 transition-opacity hover:bg-zinc-200 hover:text-zinc-900 group-hover:opacity-100 focus:opacity-100 disabled:cursor-default dark:hover:bg-zinc-700 dark:hover:text-zinc-100"
                disabled={archivingId !== null}
                onClick={() => void archiveMission(entry)}
                aria-label={`Archive ${entry.mission.title}`}
                title="Archive mission"
              >
                {archivingId === entry.mission.id ? <Spinner /> : <CloseIcon className="size-3" />}
              </button>
            </div>
          );
        })}
        <button type="button" className="dim flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg hover:bg-zinc-200 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100" disabled={!workspace.current || creating} onClick={() => void createMission()} aria-label="New mission" title="New mission">
          <PlusIcon className="size-3.5" />
        </button>
      </div>

      <ErrorBar error={error ?? feed.error} className="mx-3 mt-2" />
      <div className="flex min-h-0 flex-1">
        <MissionChat view={active} />
        <ContextShelf view={active} onUpdated={async () => { await feed.refresh(); }} />
      </div>
    </div>
  );
}
