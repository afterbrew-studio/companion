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
    // Two lists, two permissions. Either may be refused, and being refused one is
    // not an error worth a banner: a person who may only wire up their own
    // destination should still see it.
    const [shared, mine, log] = await Promise.all([
      api.channels().then((r) => r.channels).catch(() => null),
      api.myChannels().then((r) => r.channels).catch(() => null),
      api.deliveries().then((r) => r.deliveries).catch(() => null),
    ]);
    if (shared === null && mine === null) {
      setError('you do not have access to any notification channels');
      return;
    }
    setChannels([...(shared ?? []), ...(mine ?? [])]);
    setDeliveries(log ?? []);
    setError(null);
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
    create: (draft) =>
      // Owning it decides which route, and therefore which permission is checked.
      run('create', () => (draft.userId === undefined || draft.userId === null ? api.create(draft) : api.createMine(draft))),
    update: (id, fields) => run(id, () => api.update(id, fields)),
    remove: (id) => run(id, () => api.remove(id)),
    test: (id) => run(id, () => api.test(id)),
  };
}
