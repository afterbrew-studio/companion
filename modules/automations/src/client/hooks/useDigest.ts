import { useCallback, useEffect, useRef, useState } from 'react';
import { readCached, useLive, writeCached } from '@moxxy/companion-sdk/client';
import type { RepoRecord } from '@companion/module-code/contract';
import { useWorkspaceReposState } from '@companion/module-code/client';
import type { RunListRecord } from '@companion/module-operate/contract';
import { operateApi } from '@companion/module-operate/client';
import type { ReportRecord, WorkspaceRecord } from '@companion/module-workspace/contract';
import { useWorkspace, workspaceApi } from '@companion/module-workspace/client';

interface DigestSnapshot {
  readonly reports: ReportRecord[];
  readonly runs: RunListRecord[];
}

/**
 * The Daily Digest page's data: the workspace repos (the digest is per-repo),
 * the report + run feeds, and the currently-selected repo — which defaults to
 * the first repo and follows the live repo list. Kept live. Each feed is read
 * through its owning module's api slice — automations sits at the top of the
 * module graph, so code/operate/workspace are all legal imports.
 */
export function useDigest(): {
  current: WorkspaceRecord | null;
  repos: RepoRecord[];
  reports: ReportRecord[];
  runs: RunListRecord[];
  selected: string | null;
  setSelected: (repo: string | null) => void;
  loaded: boolean;
  error: string | null;
  setError: (e: string | null) => void;
  refresh: () => Promise<void>;
} {
  const { current } = useWorkspace();
  const workspaceId = current?.id;
  const { repos, loaded: reposLoaded } = useWorkspaceReposState(workspaceId);
  const cacheKey = workspaceId ? `digest:${workspaceId}` : null;
  const retained = cacheKey === null ? null : readCached<DigestSnapshot>(cacheKey);
  const [snapshot, setSnapshot] = useState<{
    readonly workspaceId: string | null;
    readonly data: DigestSnapshot;
    readonly loaded: boolean;
  }>({
    workspaceId: workspaceId ?? null,
    data: retained ?? { reports: [], runs: [] },
    loaded: retained !== null,
  });
  const [preferred, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);

  useEffect(() => {
    sequence.current += 1;
    const next = cacheKey === null ? null : readCached<DigestSnapshot>(cacheKey);
    setSnapshot({
      workspaceId: workspaceId ?? null,
      data: next ?? { reports: [], runs: [] },
      loaded: workspaceId === undefined || next !== null,
    });
    setError(null);
  }, [workspaceId, cacheKey]);

  const refresh = useCallback(async () => {
    if (!current) return;
    const requestId = ++sequence.current;
    try {
      const [rep, r] = await Promise.all([
        workspaceApi.listReports().catch(() => ({ reports: [] as ReportRecord[] })),
        operateApi
          .listRunsPage({ workspace: current.id, status: 'active', limit: 100 })
          .catch(() => ({ runs: [] as RunListRecord[], total: 0 })),
      ]);
      if (requestId !== sequence.current) return;
      const next = { reports: rep.reports, runs: r.runs };
      if (cacheKey !== null) writeCached(cacheKey, next);
      setSnapshot({ workspaceId: current.id, data: next, loaded: true });
      setError(null);
    } catch (err) {
      if (requestId !== sequence.current) return;
      setError(String(err));
      setSnapshot((value) => value.workspaceId === current.id ? { ...value, loaded: true } : value);
    }
  }, [current, cacheKey]);

  useLive(refresh, (msg) => msg.t === 'reports.changed' || msg.t === 'runs.changed' || msg.t === 'run.changed');

  // Derive the default in the render that receives cached repos. Waiting for an
  // effect would briefly render "No digest yet" for a repository that has one.
  const selected = preferred && repos.some((repo) => repo.fullName === preferred && repo.githubAccessible)
    ? preferred
    : (repos.find((repo) => repo.githubAccessible)?.fullName ?? null);

  const visible = snapshot.workspaceId === workspaceId
    ? snapshot
    : {
        workspaceId: workspaceId ?? null,
        data: retained ?? { reports: [], runs: [] },
        loaded: workspaceId === undefined || retained !== null,
      };
  return {
    current,
    repos,
    reports: visible.data.reports,
    runs: visible.data.runs,
    selected,
    setSelected,
    loaded: reposLoaded && visible.loaded,
    error: snapshot.workspaceId === workspaceId ? error : null,
    setError,
    refresh,
  };
}
