import { useState } from 'react';
import {
  Checkbox,
  EmptyState,
  ErrorBar,
  Eyebrow,
  Field,
  FormActions,
  ListCard,
  MetaSignal,
  Page,
  PageHeader,
  PageLoading,
  Section,
  SegmentedControl,
  Switch,
  timeAgo,
  useConfirm,
} from '@moxxy/companion-sdk/ui';
import { useAuth } from '@companion/module-core/client';
import type { NotificationKind } from '@companion/module-workspace/contract';
import type { NotifyChannelKind, NotifyChannelRecord } from '../../contract/index.js';
import { useChannels } from '../hooks/useChannels.js';

const KIND_OPTIONS: ReadonlyArray<{ value: NotifyChannelKind; label: string; hint: string }> = [
  { value: 'slack', label: 'Slack', hint: 'An incoming-webhook URL from a Slack app' },
  { value: 'discord', label: 'Discord', hint: 'A channel webhook URL from Discord' },
  { value: 'ntfy', label: 'ntfy', hint: 'An ntfy topic URL, e.g. https://ntfy.sh/my-topic' },
  { value: 'webhook', label: 'Webhook', hint: 'Your own endpoint, optionally HMAC-signed' },
];

const NOTIFICATION_KINDS: ReadonlyArray<{ value: NotificationKind; label: string }> = [
  { value: 'action_required', label: 'Action required' },
  { value: 'error', label: 'Errors' },
  { value: 'finished', label: 'Finished work' },
  { value: 'info', label: 'Info' },
];

/**
 * Outbound delivery: where the inbox is forwarded so people hear about it
 * without keeping a tab open. Destination URLs are credentials and are never
 * sent back to the browser, so an existing channel shows only a host hint and
 * an empty URL field means "keep what is stored".
 */
export function ChannelsPage(): JSX.Element {
  const { can } = useAuth();
  const { channels, deliveries, error, busy, create, update, remove, test } = useChannels();
  const [adding, setAdding] = useState(false);
  const { confirmDanger, confirmElement } = useConfirm();
  const manage = can('notify:manage');

  if (channels === null) return <PageLoading label="Loading channels…" />;

  return (
    <Page>
      <PageHeader
        title="Outbound notifications"
        subtitle="Forward inbox entries to Slack, Discord, ntfy or your own endpoint"
        actions={
          manage && !adding ? (
            <button className="btn" onClick={() => setAdding(true)}>
              Add channel
            </button>
          ) : null
        }
      />
      <ErrorBar error={error} />

      {adding ? (
        <Section title="New channel">
          <ChannelForm
            busy={busy === 'create'}
            onCancel={() => setAdding(false)}
            onSubmit={async (draft) => {
              await create(draft);
              setAdding(false);
            }}
          />
        </Section>
      ) : null}

      {channels.length === 0 && !adding ? (
        <EmptyState
          title="Nothing is forwarded yet"
          hint="Companion raises notifications for finished agent work, failures and things needing a decision. Add a channel so they reach you outside the app."
        />
      ) : (
        <ListCard ariaLabel="Outbound channels">
          {channels.map((channel) => (
            <ChannelRow
              key={channel.id}
              channel={channel}
              manage={manage}
              busy={busy === channel.id}
              onToggle={(enabled) => void update(channel.id, { enabled })}
              onTest={() => void test(channel.id)}
              onRemove={async () => {
                const ok = await confirmDanger({
                  title: `Delete "${channel.name}"?`,
                  message: 'Notifications stop reaching this destination, and the stored URL is discarded.',
                  confirmLabel: 'Delete',
                });
                if (ok) void remove(channel.id);
              }}
            />
          ))}
        </ListCard>
      )}

      {deliveries.length > 0 ? (
        <Section title="Recent deliveries">
          <ListCard subtle ariaLabel="Recent delivery attempts">
            {deliveries.slice(0, 20).map((delivery) => (
              <div key={delivery.id} className="flex items-baseline justify-between gap-3 px-4 py-2 text-sm">
                <span className="truncate">{delivery.title}</span>
                <span className="dim shrink-0 text-xs">{delivery.channelName}</span>
                <MetaSignal
                  tone={delivery.status === 'delivered' ? 'green' : 'red'}
                  label={
                    delivery.status === 'delivered'
                      ? 'delivered'
                      : (delivery.error ?? `failed${delivery.httpStatus ? ` (${delivery.httpStatus})` : ''}`)
                  }
                  title={delivery.attempts > 1 ? `${delivery.attempts} attempts` : undefined}
                />
                <span className="dim shrink-0 text-xs">{timeAgo(delivery.createdAt)}</span>
              </div>
            ))}
          </ListCard>
        </Section>
      ) : null}
      {confirmElement}
    </Page>
  );
}

function ChannelRow({
  channel,
  manage,
  busy,
  onToggle,
  onTest,
  onRemove,
}: {
  channel: NotifyChannelRecord;
  manage: boolean;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onTest: () => void;
  onRemove: () => void;
}): JSX.Element {
  const kind = KIND_OPTIONS.find((k) => k.value === channel.kind);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      <div className="min-w-40 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{channel.name}</span>
          <MetaSignal tone="zinc" label={kind?.label ?? channel.kind} />
          {channel.signed ? <MetaSignal tone="green" label="signed" title="Body is HMAC-signed" /> : null}
        </div>
        <p className="dim mt-0.5 font-mono text-xs">{channel.targetHint}</p>
        <p className="dim mt-0.5 text-xs">
          {channel.workspaceId === null ? 'every workspace' : 'one workspace'} ·{' '}
          {channel.kinds.length === 0
            ? 'all notification kinds'
            : channel.kinds.map((k) => NOTIFICATION_KINDS.find((n) => n.value === k)?.label ?? k).join(', ')}
        </p>
      </div>
      {channel.lastStatus ? (
        <MetaSignal
          tone={channel.lastStatus === 'delivered' ? 'green' : 'red'}
          label={channel.lastStatus === 'delivered' ? 'last: ok' : 'last: failed'}
          title={channel.lastError ?? undefined}
        />
      ) : (
        <MetaSignal tone="zinc" label="never used" />
      )}
      {manage ? (
        <div className="flex items-center gap-2">
          <button className="btn-ghost" disabled={busy} onClick={onTest}>
            Test
          </button>
          <Switch checked={channel.enabled} onChange={onToggle} disabled={busy} label={`Enable ${channel.name}`} />
          <button className="btn-ghost text-red-600 dark:text-red-400" disabled={busy} onClick={onRemove}>
            Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ChannelForm({
  busy,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  onSubmit: (draft: {
    workspaceId: null;
    kind: NotifyChannelKind;
    name: string;
    url: string;
    kinds: NotificationKind[];
    secret?: string;
    enabled: boolean;
  }) => Promise<void>;
  onCancel: () => void;
}): JSX.Element {
  const [kind, setKind] = useState<NotifyChannelKind>('slack');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [kinds, setKinds] = useState<NotificationKind[]>([]);

  const toggleKind = (value: NotificationKind): void =>
    setKinds((current) => (current.includes(value) ? current.filter((k) => k !== value) : [...current, value]));

  return (
    <form
      className="card flex flex-col gap-4 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit({
          workspaceId: null,
          kind,
          name: name.trim(),
          url: url.trim(),
          kinds,
          ...(kind === 'webhook' && secret.trim() ? { secret: secret.trim() } : {}),
          enabled: true,
        });
      }}
    >
      <Field label="Destination">
        <SegmentedControl value={kind} onChange={setKind} options={KIND_OPTIONS} label="Channel kind" name="notify-kind" />
      </Field>
      <Field label="Name" hint="Shown in the delivery log.">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
      </Field>
      <Field label="URL" hint={KIND_OPTIONS.find((k) => k.value === kind)?.hint}>
        <input
          className="input"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
          placeholder="https://…"
        />
      </Field>
      {kind === 'webhook' ? (
        <Field
          label="Signing secret (optional)"
          hint="Signs the body as x-companion-signature-256: sha256=<hex>, the same recipe GitHub uses."
        >
          <input className="input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
        </Field>
      ) : null}
      <div>
        <Eyebrow>Deliver which notifications</Eyebrow>
        <p className="dim mt-1 text-xs">Select none to deliver every kind.</p>
        <div className="mt-1.5 flex flex-wrap gap-4">
          {NOTIFICATION_KINDS.map((option) => (
            <Checkbox
              key={option.value}
              checked={kinds.includes(option.value)}
              onToggle={() => toggleKind(option.value)}
              label={option.label}
            />
          ))}
        </div>
      </div>
      <FormActions>
        <button type="button" className="btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn" disabled={busy}>
          {busy ? 'Adding…' : 'Add channel'}
        </button>
      </FormActions>
    </form>
  );
}
