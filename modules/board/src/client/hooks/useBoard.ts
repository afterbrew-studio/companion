import { useCallback, useRef, useState } from 'react';
import { useLive } from '@moxxy/companion-sdk/client';
import type { BoardConfig, TaskListRecord, WorkerView } from '../../contract/index.js';
import { boardApi } from '../api.js';

const DONE_PAGE_SIZE = 100;

/**
 * One workspace's live operational board. Completed cards are an incremental
 * archive, while every non-Done card stays present for scheduling/dependencies.
 */
export function useBoard(workspaceId: string | undefined, doneRepo?: string): {
  tasks: TaskListRecord[];
  workers: WorkerView[];
  config: BoardConfig | null;
  taskRepos: string[];
  doneTotal: number;
  doneOffset: number;
  loadingDonePage: boolean;
  loadOlderDone: () => void;
  loadNewerDone: () => void;
  loaded: boolean;
  error: string | null;
  setError: (e: string | null) => void;
  refresh: () => Promise<void>;
} {
  const queryKey = `${workspaceId ?? ''}:${doneRepo ?? ''}`;
  const [archivePage, setArchivePage] = useState({ key: queryKey, offset: 0 });
  const requestedDoneOffset = archivePage.key === queryKey ? archivePage.offset : 0;
  const [tasks, setTasks] = useState<TaskListRecord[]>([]);
  const [workers, setWorkers] = useState<WorkerView[]>([]);
  const [config, setConfig] = useState<BoardConfig | null>(null);
  const [taskRepos, setTaskRepos] = useState<string[]>([]);
  const [doneTotal, setDoneTotal] = useState(0);
  const [doneOffset, setDoneOffset] = useState(0);
  const [snapshotKey, setSnapshotKey] = useState<string | null>(null);
  const [loadingDonePage, setLoadingDonePage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const mySeq = ++seq.current;
    if (!workspaceId) {
      setTasks([]);
      setWorkers([]);
      setConfig(null);
      setTaskRepos([]);
      setDoneTotal(0);
      setDoneOffset(0);
      setSnapshotKey(queryKey);
      setLoadingDonePage(false);
      return;
    }
    try {
      const snapshot = await boardApi.get(workspaceId, requestedDoneOffset, doneRepo);
      if (seq.current !== mySeq) return;
      setTasks(snapshot.tasks);
      setWorkers(snapshot.workers);
      setConfig(snapshot.config);
      setTaskRepos(snapshot.taskRepos);
      setDoneTotal(snapshot.doneTotal);
      setDoneOffset(snapshot.doneOffset);
      if (snapshot.doneOffset !== requestedDoneOffset) {
        setArchivePage({ key: queryKey, offset: snapshot.doneOffset });
      }
      setSnapshotKey(queryKey);
      setError(null);
    } catch (err) {
      if (seq.current === mySeq) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq.current === mySeq) setLoadingDonePage(false);
    }
  }, [workspaceId, doneRepo, requestedDoneOffset, queryKey]);

  useLive(refresh, (msg) => msg.t === 'board.changed');

  const loadOlderDone = useCallback(() => {
    if (loadingDonePage) return;
    const shown = tasks.filter((task) => task.status === 'done').length;
    if (doneOffset + shown >= doneTotal) return;
    setLoadingDonePage(true);
    setArchivePage({ key: queryKey, offset: doneOffset + DONE_PAGE_SIZE });
  }, [doneOffset, doneTotal, loadingDonePage, queryKey, tasks]);

  const loadNewerDone = useCallback(() => {
    if (loadingDonePage || doneOffset === 0) return;
    setLoadingDonePage(true);
    setArchivePage({ key: queryKey, offset: Math.max(0, doneOffset - DONE_PAGE_SIZE) });
  }, [doneOffset, loadingDonePage, queryKey]);

  return {
    tasks,
    workers,
    config,
    taskRepos,
    doneTotal,
    doneOffset,
    loadingDonePage,
    loadOlderDone,
    loadNewerDone,
    loaded: snapshotKey === queryKey,
    error,
    setError,
    refresh,
  };
}
