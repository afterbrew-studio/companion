import { useCallback, useEffect, useRef, useState } from 'react';
import { onServerMessage } from '@moxxy/companion-sdk/client';
import type { IssueListRecord, PrListRecord } from '@companion/module-code/contract';
import { codeApi } from '@companion/module-code/client';

const LIVE_REFRESH_MS = 60_000;

export interface DeskOverviewFeed {
  readonly prs: readonly PrListRecord[];
  readonly issues: readonly IssueListRecord[];
  readonly totalPrs: number;
  readonly totalIssues: number;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
}

/** The Desk landing feed is intentionally bounded. It is an attention view,
 * not a second paginated maintainer queue; the full lists still live in Code. */
export function useDeskOverview(workspaceId: string | undefined, repo: string | null): DeskOverviewFeed {
  const [prs, setPrs] = useState<readonly PrListRecord[]>([]);
  const [issues, setIssues] = useState<readonly IssueListRecord[]>([]);
  const [totalPrs, setTotalPrs] = useState(0);
  const [totalIssues, setTotalIssues] = useState(0);
  const [loading, setLoading] = useState(workspaceId !== undefined);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const syncsRef = useRef(new Map<string, Promise<void>>());

  const load = useCallback(async (foreground: boolean): Promise<void> => {
    const request = ++requestRef.current;
    if (!workspaceId) {
      setPrs([]);
      setIssues([]);
      setTotalPrs(0);
      setTotalIssues(0);
      setLoading(false);
      return;
    }

    if (foreground) setLoading(true);
    setError(null);
    const page = { limit: 100, offset: 0, ...(repo ? { repo } : {}) };
    try {
      const [prFeed, issueFeed] = await Promise.all([
        codeApi.workspacePrs(workspaceId, 'open', page),
        codeApi.workspaceIssues(workspaceId, 'open', page),
      ]);
      if (requestRef.current !== request) return;
      setPrs(prFeed.prs);
      setIssues(issueFeed.issues);
      setTotalPrs(prFeed.total);
      setTotalIssues(issueFeed.total);
    } catch (err) {
      if (requestRef.current === request) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestRef.current === request) setLoading(false);
    }
  }, [repo, workspaceId]);

  /** Join one authoritative sync per workspace. Each caller reloads its own
   * current repo filter afterwards, so changing filters during a long sync
   * cannot leave the newly selected feed on the pre-sync snapshot. */
  const syncWorkspace = useCallback(async (): Promise<void> => {
    if (!workspaceId) return;
    const existing = syncsRef.current.get(workspaceId);
    if (existing) return existing;
    const syncing = (async (): Promise<void> => {
      try {
        await codeApi.refreshWorkspace(workspaceId);
      } finally {
        syncsRef.current.delete(workspaceId);
      }
    })();
    syncsRef.current.set(workspaceId, syncing);
    return syncing;
  }, [workspaceId]);

  /** Pull authoritative GitHub state before re-reading the bounded Desk feed.
   * Kept in DeskRoot, so it continues on mission/context pages rather than
   * depending on the full Code lists having been opened first. */
  const refreshFromGitHub = useCallback(async (): Promise<void> => {
    if (!workspaceId) return;
    try {
      await syncWorkspace();
      await load(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [load, syncWorkspace, workspaceId]);

  // A consumer asking for refresh expects GitHub, not another read of SQLite.
  const refresh = useCallback((): Promise<void> => refreshFromGitHub(), [refreshFromGitHub]);

  useEffect(() => {
    void load(true);
    void refreshFromGitHub();
    const offMessage = onServerMessage((message) => {
      if (message.t === 'prs.changed' || message.t === 'issues.changed' || message.t === 'triage.changed') {
        if ((!repo || message.repo === repo) && !syncsRef.current.has(workspaceId ?? '')) void load(false);
      } else if (message.t === 'prStatus.changed') {
        if (!repo || message.repo === repo) void load(false);
      }
    });
    const refreshVisible = (): void => {
      if (document.visibilityState === 'visible') void refreshFromGitHub();
    };
    const timer = window.setInterval(refreshVisible, LIVE_REFRESH_MS);
    document.addEventListener('visibilitychange', refreshVisible);
    window.addEventListener('focus', refreshVisible);
    return () => {
      offMessage();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshVisible);
      window.removeEventListener('focus', refreshVisible);
    };
  }, [load, refreshFromGitHub, repo, workspaceId]);

  return { prs, issues, totalPrs, totalIssues, loading, error, refresh };
}
