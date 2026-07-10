import { useCallback, useEffect, useState } from 'react';
import { onServerMessage } from '@companion/core/client';
import { useAuth } from '@companion/module-core/client';
import type { NotificationScope } from '@companion/module-core/contract';
import type { NotificationRecord } from '../../contract/index.js';
import { workspaceApi } from '../api.js';
import { useWorkspace } from '../lib/workspace.js';

export interface UseNotifications {
  readonly items: readonly NotificationRecord[];
  readonly unread: number;
  /** The scope the inbox is currently resolved to. */
  readonly scope: NotificationScope;
  readonly markRead: (id: string) => void;
  readonly markAllRead: () => void;
  readonly refresh: () => Promise<void>;
}

/**
 * The inbox feed, scoped by the user's effective preference: `workspace` (the
 * default) pins it to the active workspace (plus instance-wide events);
 * `global` aggregates every workspace the user can access. Both the header bell
 * and the full Inbox page read from here so they never drift.
 */
export function useNotifications(): UseNotifications {
  const { current } = useWorkspace();
  const { notificationScope } = useAuth();
  // Global mode omits the workspace filter; workspace mode pins to the current one.
  const workspaceArg = notificationScope === 'global' ? undefined : current?.id;
  const [items, setItems] = useState<NotificationRecord[]>([]);

  const refresh = useCallback(async () => {
    try {
      const { notifications } = await workspaceApi.listNotifications(workspaceArg);
      setItems(notifications);
    } catch {
      // signed-out or transient — the badge just stays empty
    }
  }, [workspaceArg]);

  useEffect(() => {
    void refresh();
    return onServerMessage((msg) => {
      if (msg.t === 'notifications.changed') void refresh();
    });
  }, [refresh]);

  const unread = items.filter((n) => n.readAt === null).length;

  // Server broadcasts notifications.changed, which refetches; markRead is a
  // no-op on already-read rows so double taps are harmless.
  const markRead = useCallback((id: string): void => {
    void workspaceApi.markNotificationRead(id).catch(() => undefined);
  }, []);

  const markAllRead = useCallback((): void => {
    void workspaceApi.markAllNotificationsRead(workspaceArg).catch(() => undefined);
  }, [workspaceArg]);

  return { items, unread, scope: notificationScope, markRead, markAllRead, refresh };
}
