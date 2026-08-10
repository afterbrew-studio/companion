import type { NotificationRecord } from '@companion/module-workspace/contract';
import { NOTIFICATION_KIND_OPTIONS } from '@companion/module-integrations/provider';
import type {
  IntegrationConnectionAccess,
  IntegrationNotificationInput,
  IntegrationProviderAdapter,
} from '@companion/module-integrations/provider';
import { buildRequest, deliver, type NotificationProviderKind } from './delivery.js';

type ProviderKind = NotificationProviderKind;

const DEFINITIONS: ReadonlyArray<{
  readonly id: string;
  readonly kind: ProviderKind;
  readonly vendor: string;
  readonly title: string;
  readonly description: string;
  readonly docsUrl: string;
  readonly signingSecret: boolean;
  readonly supportsPersonal: boolean;
}> = [
  {
    id: 'slack.webhook',
    kind: 'slack',
    vendor: 'Slack',
    title: 'Slack incoming webhook',
    description: 'Deliver Companion decisions, failures and finished work into a Slack channel.',
    docsUrl: 'https://api.slack.com/messaging/webhooks',
    signingSecret: false,
    supportsPersonal: true,
  },
  {
    id: 'discord.webhook',
    kind: 'discord',
    vendor: 'Discord',
    title: 'Discord webhook',
    description: 'Deliver Companion activity into a Discord channel through its native webhook.',
    docsUrl: 'https://docs.discord.com/developers/resources/webhook',
    signingSecret: false,
    supportsPersonal: true,
  },
  {
    id: 'ntfy.http',
    kind: 'ntfy',
    vendor: 'ntfy',
    title: 'ntfy topic',
    description: 'Send lightweight Companion notifications to an ntfy topic.',
    docsUrl: 'https://docs.ntfy.sh/publish/',
    signingSecret: false,
    supportsPersonal: false,
  },
  {
    id: 'webhook.generic',
    kind: 'webhook',
    vendor: 'Webhook',
    title: 'Signed webhook',
    description: 'Send the complete notification envelope to your own HTTP endpoint, optionally HMAC-signed.',
    docsUrl: 'https://github.com/moxxy-ai/companion',
    signingSecret: true,
    supportsPersonal: false,
  },
];

export function notificationProviders(publicUrl: () => string | null): IntegrationProviderAdapter[] {
  return DEFINITIONS.map((definition) => {
    const adapter: IntegrationProviderAdapter = {
      descriptor: {
        id: definition.id,
        moduleId: 'notify',
        vendor: definition.vendor,
        title: definition.title,
        description: definition.description,
        category: 'communication',
        capabilities: ['notifications'],
        scopes: ['instance', 'workspace', 'repository'],
        connectionMode: 'required',
        execution: 'remote',
        supportsPersonal: definition.supportsPersonal,
        docsUrl: definition.docsUrl,
        setup: 'The destination URL is stored as a write-only secret. Leave event kinds empty to receive everything.',
        fields: [
          {
            key: 'url',
            label: 'Webhook or topic URL',
            kind: 'secret',
            required: true,
            description: 'Write-only because possession of this URL usually grants posting access.',
          },
          {
            key: 'eventKinds',
            label: 'Event kinds',
            kind: 'multiselect',
            options: NOTIFICATION_KIND_OPTIONS,
            description: 'Pick nothing to receive every kind.',
          },
          ...(definition.signingSecret
            ? [{
                key: 'signingSecret',
                label: 'HMAC signing secret',
                kind: 'secret' as const,
                description: 'Adds x-companion-signature-256 over the exact request body.',
              }]
            : []),
        ],
      },
      validateConfig: (config, secret) => {
        notificationTarget(secret('url'), definition.kind);
        validateEventKinds(config.eventKinds);
      },
      acceptsNotification: acceptsIntegrationNotification,
      notify: (connection, input) => send(definition.kind, connection, input, publicUrl),
      probe: async (connection) => {
        const outcome = await send(definition.kind, connection, testNotification(connection.record.name), publicUrl);
        return {
          status: outcome.ok ? 'ready' : 'unavailable',
          message: outcome.ok ? 'Test notification delivered' : (outcome.error ?? 'Test delivery failed'),
          checkedAt: Date.now(),
        };
      },
    };
    return adapter;
  });
}

function notificationTarget(rawUrl: string | null, kind: ProviderKind): URL {
  if (!rawUrl) throw new Error('Notification destination URL is required');
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    throw new Error('Notification destination URL is invalid');
  }
  if ((target.protocol !== 'http:' && target.protocol !== 'https:') || target.username || target.password) {
    throw new Error('Notification destination must use HTTP(S) without embedded credentials');
  }
  if ((kind === 'slack' || kind === 'discord') && target.protocol !== 'https:') {
    throw new Error(`${kind === 'slack' ? 'Slack' : 'Discord'} webhooks must use HTTPS`);
  }
  if (
    kind === 'slack' &&
    (!['hooks.slack.com', 'hooks.slack-gov.com'].includes(target.hostname.toLowerCase()) ||
      !target.pathname.startsWith('/services/'))
  ) {
    throw new Error('Slack webhook must be an official hooks.slack.com URL');
  }
  if (
    kind === 'discord' &&
    (!['discord.com', 'discordapp.com'].includes(target.hostname.toLowerCase()) ||
      !target.pathname.startsWith('/api/webhooks/'))
  ) {
    throw new Error('Discord webhook must be an official discord.com API webhook URL');
  }
  return target;
}

export function acceptsIntegrationNotification(
  connection: IntegrationConnectionAccess,
  notification: IntegrationNotificationInput,
): boolean {
  const raw = connection.record.config.eventKinds;
  if (typeof raw !== 'string' || !raw.trim()) return true;
  const kinds = eventKinds(raw);
  return kinds.has(notification.kind);
}

// Derived from the options the form offers, so the menu and the allow-list
// cannot drift into disagreeing about what a valid kind is.
const NOTIFICATION_KINDS = new Set(NOTIFICATION_KIND_OPTIONS.map((option) => option.value));

function eventKinds(value: string): Set<string> {
  return new Set(value.split(',').map((kind) => kind.trim()).filter(Boolean));
}

function validateEventKinds(value: unknown): void {
  if (value === undefined || value === '') return;
  if (typeof value !== 'string') throw new Error('Event kinds must be comma-separated text');
  const unsupported = [...eventKinds(value)].filter((kind) => !NOTIFICATION_KINDS.has(kind));
  if (unsupported.length > 0) throw new Error(`Unsupported event kind: ${unsupported.join(', ')}`);
}

async function send(
  kind: ProviderKind,
  connection: IntegrationConnectionAccess,
  input: IntegrationNotificationInput,
  publicUrl: () => string | null,
) {
  const url = connection.secret('url');
  if (!url) return { ok: false, httpStatus: null, error: 'destination URL is not configured', attempts: 0 };
  try {
    const request = buildRequest(kind, url, toNotification(input), {
      publicUrl: publicUrl(),
      secret: connection.secret('signingSecret'),
    });
    // Every built-in HTTP destination is user-controlled configuration. Shared
    // connections are privileged, but still do not need ambient access to the
    // daemon's LAN or cloud metadata endpoint.
    return await deliver(request, fetch, { publicOnly: true });
  } catch (error) {
    return {
      ok: false,
      httpStatus: null,
      error: String(error instanceof Error ? error.message : error).slice(0, 1_000),
      attempts: 0,
    };
  }
}

function toNotification(input: IntegrationNotificationInput): NotificationRecord {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    userId: null,
    repo: input.repo,
    kind: input.kind,
    title: input.title,
    body: input.body,
    href: input.href,
    readAt: null,
    createdAt: input.createdAt,
  };
}

function testNotification(name: string): IntegrationNotificationInput {
  return {
    id: `integration-test-${Date.now()}`,
    kind: 'info',
    title: 'Companion test notification',
    body: `If you can read this, “${name}” is wired up correctly.`,
    workspaceId: null,
    repo: null,
    href: null,
    url: null,
    createdAt: Date.now(),
  };
}
