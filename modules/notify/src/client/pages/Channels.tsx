import { useCallback, useState } from 'react';
import { useLive } from '@moxxy/companion-sdk/client';
import {
  EmptyState,
  ErrorBar,
  ListCard,
  MetaSignal,
  Page,
  PageHeader,
  PageLoading,
  timeAgo,
} from '@moxxy/companion-sdk/ui';
import type { NotifyDeliveryRecord } from '../../contract/index.js';
import { notifyApi } from '../api.js';

/** Operational history; destinations themselves are managed in Integrations. */
export function ChannelsPage(): React.JSX.Element {
  const [deliveries, setDeliveries] = useState<readonly NotifyDeliveryRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async (): Promise<void> => {
    try {
      // More history than the server's 100 default; still bounded well below
      // the route's 500 ceiling so the page stays a quick diagnostic view.
      const result = await notifyApi.deliveries({ limit: 250 });
      setDeliveries(result.deliveries);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useLive(refresh, (message) => message.t === 'notify.changed');

  if (deliveries === null && !error) return <PageLoading label="Loading delivery history…" />;

  return (
    <Page>
      <PageHeader
        title="Notification delivery"
        subtitle="Recent attempts across Slack, Discord, Jira Automation, ntfy and webhooks"
        actions={<a className="btn" href="#/integrations">Manage integrations</a>}
      />
      <ErrorBar error={error} />
      {(deliveries?.length ?? 0) === 0 ? (
        <EmptyState
          title="No delivery attempts yet"
          hint="Connect a notification provider in Integrations. New activity will appear here with its destination and outcome."
        />
      ) : (
        <ListCard subtle ariaLabel="Recent notification delivery attempts">
          {deliveries!.map((delivery) => (
            <div key={delivery.id} className="flex flex-wrap items-baseline gap-3 px-4 py-2.5 text-sm">
              <span className="min-w-48 flex-1 truncate">{delivery.title}</span>
              <span className="dim shrink-0 text-xs">
                {delivery.connectionName} · {delivery.providerId}
              </span>
              <MetaSignal
                tone={delivery.status === 'delivered' ? 'green' : 'red'}
                label={delivery.status === 'delivered'
                  ? 'delivered'
                  : (delivery.error ?? `failed${delivery.httpStatus ? ` (${delivery.httpStatus})` : ''}`)}
                title={delivery.attempts > 1 ? `${delivery.attempts} attempts` : undefined}
              />
              <span className="dim shrink-0 text-xs">{timeAgo(delivery.createdAt)}</span>
            </div>
          ))}
        </ListCard>
      )}
    </Page>
  );
}
