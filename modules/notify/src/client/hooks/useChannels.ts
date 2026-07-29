import { useCallback, useState } from 'react';
import { useLive } from '@moxxy/companion-sdk/client';
import type { NotifyChannelDraft, NotifyChannelRecord, NotifyDeliveryRecord } from '../../contract/index.js';
import { notifyApi as api } from '../api.js';

export interface ChannelsState {
  readonly channels: readonly NotifyChannelRecord[] | null;
  readonly deliveries: readonly NotifyDeliveryRecord[];
  readonly error: string | null;
  readonly busy: string | null;
  create: (draft: NotifyChannelDraft) => Promise<void>;
  update: (id: string, fields: Partial<NotifyChannelDraft>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  test: (id: string) => Promise<void>;
}

/**
 * Channels and their recent delivery attempts, kept live on `notify.changed`.
 * Every mutation refreshes rather than patching local state: a delivery attempt
 * updates the channel's last-status too, and reconciling that by hand is how
 * the list ends up disagreeing with the server.
 */
export function useChannels(): ChannelsState {
  const [channels, setChannels] = useState<readonly NotifyChannelRecord[] | null>(null);
  const [deliveries, setDeliveries] = useState<readonly NotifyDeliveryRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [c, d] = await Promise.all([api.channels(), api.deliveries()]);
      setChannels(c.channels);
      setDeliveries(d.deliveries);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useLive(refresh, (msg) => msg.t === 'notify.changed');

  const run = useCallback(
    async (key: string, action: () => Promise<unknown>): Promise<void> => {
      setBusy(key);
      setError(null);
      try {
        await action();
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  return {
    channels,
    deliveries,
    error,
    busy,
    create: (draft) => run('create', () => api.create(draft)),
    update: (id, fields) => run(id, () => api.update(id, fields)),
    remove: (id) => run(id, () => api.remove(id)),
    test: (id) => run(id, () => api.test(id)),
  };
}
