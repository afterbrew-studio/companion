import { useCallback, useEffect, useState } from 'react';
import { onServerMessage } from '@moxxy/companion-sdk/client';
import { useAuth } from '@companion/module-core/client';
import type { NotificationScope } from '@companion/module-core/contract';
import type { NotificationRecord } from '../../contract/index.js';
import { workspaceApi, type NotificationCursor } from '../api.js';
import { useWorkspace } from '../lib/workspace.js';

export interface UseNotifications {
  readonly items: readonly NotificationRecord[];
  readonly unread: number;
  /** The scope the inbox is currently resolved to. */
  readonly scope: NotificationScope;
  /** True until the first answer for the current scope; a reload keeps rows on screen. */
  readonly loading: boolean;
  readonly error: string | null;
  readonly hasMore: boolean;
  readonly loadMore: () => void;
  readonly markRead: (id: string) => void;
  readonly markAllRead: () => void;
  readonly refresh: () => Promise<void>;
}

/**
 * The inbox feed, scoped by the user's effective preference: `workspace` (the
 * default) pins it to the active workspace (plus instance-wide events);
 * `global` aggregates every workspace the user can access. Both the header bell
 * and the full Inbox page read from here so they never drift. The archive
 * follows the server's keyset cursor page by page.
 */
export function useNotifications(): UseNotifications {
  const { current } = useWorkspace();
  const { notificationScope } = useAuth();
  // Global mode omits the workspace filter; workspace mode pins to the current one.
  const workspaceArg = notificationScope === 'global' ? undefined : current?.id;
  const [items, setItems] = useState<NotificationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<NotificationCursor | null>(null);

  useEffect(() => {
    setItems([]);
    setCursor(null);
    setLoading(true);
    setError(null);
  }, [workspaceArg]);

  const refresh = useCallback(async () => {
    try {
      const { notifications, nextCursor } = await workspaceApi.listNotifications(workspaceArg);
      setItems(notifications);
      setCursor(nextCursor ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [workspaceArg]);

  const loadMore = useCallback((): void => {
    if (!cursor) return;
    void workspaceApi
      .listNotifications(workspaceArg, cursor)
      .then(({ notifications, nextCursor }) => {
        setItems((currentItems) => [...currentItems, ...notifications]);
        setCursor(nextCursor ?? null);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [workspaceArg, cursor]);

  useEffect(() => {
    void refresh();
    return onServerMessage((msg) => {
      if (msg.t === 'notifications.changed') void refresh();
    });
  }, [refresh]);

  const unread = items.filter((n) => n.readAt === null).length;

  // Make acknowledgement feel immediate. The server broadcast reconciles the
  // timestamp after success; a failed request restores authoritative state.
  const markRead = useCallback((id: string): void => {
    const optimisticReadAt = Date.now();
    setItems((currentItems) =>
      currentItems.map((item) => (item.id === id && item.readAt === null ? { ...item, readAt: optimisticReadAt } : item)),
    );
    void workspaceApi.markNotificationRead(id).catch(() => void refresh());
  }, [refresh]);

  const markAllRead = useCallback((): void => {
    const optimisticReadAt = Date.now();
    setItems((currentItems) =>
      currentItems.map((item) => (item.readAt === null ? { ...item, readAt: optimisticReadAt } : item)),
    );
    void workspaceApi.markAllNotificationsRead(workspaceArg).catch(() => void refresh());
  }, [refresh, workspaceArg]);

  return {
    items,
    unread,
    scope: notificationScope,
    loading,
    error,
    hasMore: cursor !== null,
    loadMore,
    markRead,
    markAllRead,
    refresh,
  };
}
