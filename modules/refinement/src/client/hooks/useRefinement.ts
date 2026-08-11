import { useCallback, useMemo, useState } from 'react';
import { ApiError, useLive } from '@moxxy/companion-sdk/client';
import { useWorkspace } from '@companion/module-workspace/client';
import type { WorkspaceRecord } from '@companion/module-workspace/contract';
import type { RefineContextOptions, RefineItemUpdate, RefineMethodDraft, RefineMethodRecord } from '../../contract/index.js';
import { refinementApi, type RefinementDetail } from '../api.js';

export interface RefinementActions {
  update(fields: { title?: string; story?: string; branch?: string }): Promise<void>;
  decompose(methodId: string, specIds: string[], docIds: string[]): Promise<void>;
  importItem(itemId: string, queue: boolean, targetBranch?: string): Promise<void>;
  importAll(queue: boolean, targetBranch?: string): Promise<void>;
  dismissItem(itemId: string): Promise<void>;
  updateItem(itemId: string, fields: RefineItemUpdate): Promise<void>;
  moveItem(itemId: string, direction: 'up' | 'down'): Promise<void>;
  mergeItems(itemIds: string[]): Promise<void>;
  /** Resolves true when deleted (the caller navigates away). */
  remove(): Promise<boolean>;
  /** Throws on failure; the methods modal keeps the editor open with the error inline. */
  saveMethod(fields: { name: string; description: string; instructions: string }): Promise<void>;
  /** Throws on failure; the methods modal keeps the editor open with the error inline. */
  updateMethod(id: string, fields: { name?: string; description?: string; instructions?: string }): Promise<void>;
  deleteMethod(id: string): Promise<void>;
  /** Throws on failure — the methods modal shows the error inline, not in the page bar. */
  generateMethod(prompt: string): Promise<RefineMethodDraft>;
}

/**
 * One refinement's detail view: the record + its items, the workspace's
 * decomposition methods and the spec/doc picker options — kept live over
 * refinement.changed (every mutation and agent transition broadcasts it).
 */
export function useRefinement(id: string): {
  current: WorkspaceRecord | null;
  detail: RefinementDetail | null;
  methods: RefineMethodRecord[];
  context: RefineContextOptions | null;
  /** The refinement disappeared (deleted, or not visible to this user). */
  missing: boolean;
  error: string | null;
  setError: (e: string | null) => void;
  refresh: () => Promise<void>;
  actions: RefinementActions;
} {
  const { current } = useWorkspace();
  const [detail, setDetail] = useState<RefinementDetail | null>(null);
  const [methods, setMethods] = useState<RefineMethodRecord[]>([]);
  const [context, setContext] = useState<RefineContextOptions | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    let fetched: RefinementDetail;
    try {
      fetched = await refinementApi.get(id);
      setDetail(fetched);
      setMissing(false);
    } catch (err) {
      // Only a real 404 means gone — a transient failure must not swap the
      // page to the not-found state.
      if (err instanceof ApiError && err.status === 404) setMissing(true);
      else setError(String(err));
      return;
    }
    // Secondary panels: the page renders without them, but a failure must
    // surface instead of silently leaving the pickers empty.
    void refinementApi
      .contextOptions(id)
      .then(setContext)
      .catch((err) => setError(String(err)));
    // Methods belong to the refinement's workspace, not the switcher's.
    if (fetched.workspaceId) {
      void refinementApi
        .methods(fetched.workspaceId)
        .then((r) => setMethods(r.methods))
        .catch((err) => setError(String(err)));
    }
  }, [id]);

  useLive(refresh, (msg) => msg.t === 'refinement.changed');

  const act = useCallback(
    async (fn: () => Promise<unknown>): Promise<void> => {
      try {
        await fn();
        setError(null);
        await refresh();
      } catch (err) {
        setError(String(err));
      }
    },
    [refresh],
  );

  const actions = useMemo<RefinementActions>(
    () => ({
      update: (fields) => act(() => refinementApi.update(id, fields)),
      decompose: (methodId, specIds, docIds) => act(() => refinementApi.decompose(id, { methodId, specIds, docIds })),
      importItem: (itemId, queue, targetBranch) =>
        act(() => refinementApi.importItem(id, itemId, queue, targetBranch)),
      importAll: (queue, targetBranch) => act(() => refinementApi.importAll(id, queue, targetBranch)),
      dismissItem: (itemId) => act(() => refinementApi.dismissItem(id, itemId)),
      updateItem: (itemId, fields) => act(() => refinementApi.updateItem(id, itemId, fields)),
      moveItem: (itemId, direction) => act(() => refinementApi.moveItem(id, itemId, direction)),
      mergeItems: (itemIds) => act(() => refinementApi.mergeItems(id, itemIds, {})),
      remove: async () => {
        try {
          await refinementApi.remove(id);
          return true;
        } catch (err) {
          setError(String(err));
          return false;
        }
      },
      saveMethod: async (fields) => {
        const workspaceId = detail?.workspaceId;
        if (!workspaceId) return;
        await refinementApi.saveMethod(workspaceId, fields);
        await refresh();
      },
      updateMethod: async (methodId, fields) => {
        await refinementApi.updateMethod(methodId, fields);
        await refresh();
      },
      deleteMethod: (methodId) => act(() => refinementApi.deleteMethod(methodId)),
      generateMethod: async (prompt) => {
        const workspaceId = detail?.workspaceId;
        if (!workspaceId) throw new Error('the refinement has no workspace');
        return (await refinementApi.generateMethod(workspaceId, prompt)).draft;
      },
    }),
    [act, refresh, id, detail?.workspaceId],
  );

  return { current, detail, methods, context, missing, error, setError, refresh, actions };
}
