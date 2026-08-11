import { NOTIFICATION_KIND_OPTIONS } from '@companion/module-integrations/provider';
import type {
  IntegrationConnectionAccess,
  IntegrationNotificationInput,
  IntegrationProviderAdapter,
} from '@companion/module-integrations/provider';
import type { IntegrationFieldValue, ResolveAddresses } from '@moxxy/companion-sdk/server';
import type { DeliveryOutcome } from './delivery.js';
import {
  acceptsIntegrationNotification,
  testNotification,
  validateEventKinds,
} from './notification-providers.js';
import {
  assertEmailAddress,
  assertPlausibleSmtpHost,
  assertPublicSmtpHost,
  deliverEmail,
} from './smtp.js';

/** Somebody pasting a whole mailing list into one connection is misconfiguring
 * it; a distribution list belongs in the mail system, not here. */
const MAX_RECIPIENTS = 20;

interface SmtpSettings {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly username: string | null;
  readonly password: string | null;
  readonly from: string;
  readonly to: readonly string[];
}

export function smtpNotificationProvider(resolve?: ResolveAddresses): IntegrationProviderAdapter {
  const adapter: IntegrationProviderAdapter = {
    descriptor: {
      id: 'smtp.email',
      moduleId: 'notify',
      vendor: 'Email',
      title: 'Email (SMTP)',
      description: 'Deliver Companion notifications as plain-text email through any SMTP server.',
      category: 'communication',
      capabilities: ['notifications'],
      scopes: ['instance', 'workspace', 'repository'],
      connectionMode: 'required',
      execution: 'remote',
      supportsPersonal: true,
      docsUrl: 'https://github.com/moxxy-ai/companion',
      setup: 'The password is stored as a write-only secret. Leave event kinds empty to receive everything.',
      fields: [
        { key: 'host', label: 'SMTP host', kind: 'text', required: true, placeholder: 'smtp.example.com' },
        {
          key: 'port',
          label: 'Port',
          kind: 'text',
          description: 'Defaults to 465 with implicit TLS and 587 with STARTTLS.',
        },
        {
          key: 'secure',
          label: 'Implicit TLS (SMTPS)',
          kind: 'boolean',
          default: true,
          description: 'Off negotiates STARTTLS instead; delivery fails rather than downgrade to plaintext.',
        },
        { key: 'username', label: 'Username', kind: 'text' },
        {
          key: 'password',
          label: 'Password',
          kind: 'secret',
          description: 'Write-only. Required when a username is set.',
        },
        { key: 'from', label: 'From address', kind: 'text', required: true, placeholder: 'companion@example.com' },
        {
          key: 'to',
          label: 'Recipients',
          kind: 'text',
          required: true,
          description: 'Comma-separated addresses this connection delivers to.',
        },
        {
          key: 'eventKinds',
          label: 'Event kinds',
          kind: 'multiselect',
          options: NOTIFICATION_KIND_OPTIONS,
          description: 'Pick nothing to receive every kind.',
        },
      ],
    },
    validateConfig: (config, secret) => {
      smtpSettings(config, secret);
      validateEventKinds(config.eventKinds);
    },
    acceptsNotification: acceptsIntegrationNotification,
    notify: (connection, input) => sendEmailNotification(connection, input, resolve),
    probe: async (connection) => {
      const outcome = await sendEmailNotification(connection, testNotification(connection.record.name), resolve);
      return {
        status: outcome.ok ? 'ready' : 'unavailable',
        message: outcome.ok ? 'Test email delivered' : (outcome.error ?? 'Test delivery failed'),
        checkedAt: Date.now(),
      };
    },
  };
  return adapter;
}

async function sendEmailNotification(
  connection: IntegrationConnectionAccess,
  input: IntegrationNotificationInput,
  resolve?: ResolveAddresses,
): Promise<DeliveryOutcome> {
  try {
    const settings = smtpSettings(connection.record.config, connection.secret);
    // SMTP is a raw socket, so the destination gets the same public-only rule
    // as every built-in HTTP channel, with the address pinned once resolved.
    const [address] = await assertPublicSmtpHost(settings.host, resolve);
    return await deliverEmail(
      {
        host: settings.host,
        address: address!,
        port: settings.port,
        secure: settings.secure,
        username: settings.username,
        password: settings.password,
      },
      {
        from: settings.from,
        to: settings.to,
        subject: input.title,
        text: [input.body.trim(), input.url].filter(Boolean).join('\n\n'),
      },
    );
  } catch (error) {
    return {
      ok: false,
      httpStatus: null,
      error: String(error instanceof Error ? error.message : error).slice(0, 1_000),
      attempts: 0,
    };
  }
}

function smtpSettings(
  config: Readonly<Record<string, IntegrationFieldValue>>,
  secret: (key: string) => string | null,
): SmtpSettings {
  const host = assertPlausibleSmtpHost(requiredText(config.host, 'SMTP host'));
  const secure = config.secure === undefined || config.secure === '' ? true : config.secure === true || config.secure === 'true';
  const port = smtpPort(config.port, secure);
  const username = optionalText(config.username);
  const password = secret('password');
  if (username && !password) throw new Error('SMTP password is required when a username is set');
  if (!username && password) throw new Error('SMTP username is required when a password is set');
  const from = assertEmailAddress(requiredText(config.from, 'From address'), 'From address');
  const to = recipients(requiredText(config.to, 'Recipients'));
  return { host, port, secure, username: username ?? null, password: password ?? null, from, to };
}

function smtpPort(value: IntegrationFieldValue | undefined, secure: boolean): number {
  if (value === undefined || value === '') return secure ? 465 : 587;
  const port = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('SMTP port must be between 1 and 65535');
  return port;
}

function recipients(value: string): readonly string[] {
  const addresses = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => assertEmailAddress(entry, 'Recipient'));
  if (addresses.length === 0) throw new Error('At least one recipient address is required');
  if (addresses.length > MAX_RECIPIENTS) throw new Error(`At most ${MAX_RECIPIENTS} recipient addresses are supported`);
  return addresses;
}

function requiredText(value: IntegrationFieldValue | undefined, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function optionalText(value: IntegrationFieldValue | undefined): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim();
}
