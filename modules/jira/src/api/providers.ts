import { NOTIFICATION_KIND_OPTIONS } from '@companion/module-integrations/provider';
import { withPublicHttpResponse } from '@moxxy/companion-sdk/server';
import type {
  IntegrationConnectionAccess,
  IntegrationNotificationInput,
  IntegrationProviderAdapter,
} from '@companion/module-integrations/provider';
import { JiraCloudClient, jiraSiteOrigin } from './jira-client.js';

export const jiraCloudProvider: IntegrationProviderAdapter = {
  descriptor: {
    id: 'jira.cloud',
    moduleId: 'jira',
    vendor: 'Jira',
    title: 'Jira Cloud',
    description: 'Link Jira tickets to GitHub work, comment on them and move them through available transitions.',
    category: 'project-management',
    capabilities: ['issue-tracking'],
    scopes: ['instance', 'workspace', 'repository'],
    connectionMode: 'required',
    execution: 'remote',
    docsUrl: 'https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/',
    fields: [
      {
        key: 'baseUrl',
        label: 'Jira site URL',
        kind: 'url',
        required: true,
        placeholder: 'https://your-company.atlassian.net',
      },
      { key: 'email', label: 'Atlassian account email', kind: 'text', required: true },
      {
        key: 'apiToken',
        label: 'API token',
        kind: 'secret',
        required: true,
        description: 'Write-only. Create a scoped token for the account Companion should act as.',
      },
    ],
  },
  validateConfig: (config) => {
    const baseUrl = config.baseUrl;
    if (typeof baseUrl !== 'string') throw new Error('Jira site URL is required');
    jiraSiteOrigin(baseUrl);
  },
  probe: async (connection) => {
    try {
      await new JiraCloudClient(connection).me();
      return { status: 'ready', message: 'Authenticated with Jira Cloud', checkedAt: Date.now() };
    } catch (error) {
      return {
        status: 'unavailable',
        message: String(error instanceof Error ? error.message : error).slice(0, 1_000),
        checkedAt: Date.now(),
      };
    }
  },
};

export const jiraAutomationProvider: IntegrationProviderAdapter = {
  descriptor: {
    id: 'jira.automation',
    moduleId: 'jira',
    vendor: 'Jira',
    title: 'Jira Automation webhook',
    description: 'Send Companion events into a Jira Automation rule without granting Jira issue API access.',
    category: 'communication',
    capabilities: ['notifications'],
    scopes: ['instance', 'workspace', 'repository'],
    connectionMode: 'required',
    execution: 'remote',
    docsUrl: 'https://support.atlassian.com/cloud-automation/docs/configure-the-incoming-webhook-trigger-in-atlassian-automation/',
    fields: [
      { key: 'url', label: 'Incoming webhook URL', kind: 'secret', required: true },
      {
        key: 'token',
        label: 'Webhook token',
        kind: 'secret',
        description: 'Optional X-Automation-Webhook-Token configured by the Jira rule.',
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
  validateConfig: (_config, secret) => {
    jiraAutomationTarget(secret('url'));
    validateEventKinds(_config.eventKinds);
  },
  acceptsNotification: (connection, notification) => {
    const rawKinds = connection.record.config.eventKinds;
    return typeof rawKinds !== 'string' || !rawKinds.trim() || eventKinds(rawKinds).has(notification.kind);
  },
  notify: sendAutomation,
  probe: async (connection) => {
    const outcome = await sendAutomation(connection, {
      id: `jira-test-${Date.now()}`,
      kind: 'info',
      title: 'Companion test notification',
      body: 'The Jira Automation webhook is connected.',
      workspaceId: null,
      repo: null,
      href: null,
      url: null,
      createdAt: Date.now(),
    });
    return {
      status: outcome.ok ? 'ready' : 'unavailable',
      message: outcome.ok ? 'Test event accepted by Jira Automation' : (outcome.error ?? 'Test event failed'),
      checkedAt: Date.now(),
    };
  },
};

/** A transient failure is retried once, after this pause. */
const RETRY_DELAY_MS = 2_000;

/** 429 and 5xx are the receiver having a moment; 4xx is us being wrong. */
function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

interface AutomationOutcome {
  readonly ok: boolean;
  readonly httpStatus: number | null;
  readonly error: string | null;
  readonly attempts: number;
}

/**
 * Same retry semantics as the notify providers (see
 * modules/notify/src/api/delivery.ts `deliver`): one retry on 429/5xx or a
 * network error; a 4xx is final; never throws. The transport is injectable so
 * the retry behaviour is asserted in tests without a network.
 */
export async function sendAutomation(
  connection: IntegrationConnectionAccess,
  notification: IntegrationNotificationInput,
  transport: typeof withPublicHttpResponse = withPublicHttpResponse,
): Promise<AutomationOutcome> {
  const url = connection.secret('url');
  if (!url) return { ok: false, httpStatus: null, error: 'webhook URL is not configured', attempts: 0 };
  const token = connection.secret('token');
  let target: URL;
  try {
    target = jiraAutomationTarget(url);
  } catch (error) {
    return { ok: false, httpStatus: null, error: errorText(error), attempts: 0 };
  }
  let last: AutomationOutcome = { ok: false, httpStatus: null, error: 'not attempted', attempts: 0 };
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      last = await transport(
        target,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(token ? { 'x-automation-webhook-token': token } : {}),
          },
          body: JSON.stringify(notification),
          signal: AbortSignal.timeout(10_000),
          redirect: 'manual',
        },
        async (response) => {
          await response.body?.cancel().catch(() => undefined);
          return {
            ok: response.ok,
            httpStatus: response.status,
            error: response.ok ? null : `Jira Automation returned ${response.status}`,
            attempts: attempt,
          };
        },
      );
      if (last.ok || (last.httpStatus !== null && !retryable(last.httpStatus))) return last;
    } catch (error) {
      last = { ok: false, httpStatus: null, error: errorText(error), attempts: attempt };
      // An SSRF-guard refusal is deterministic; retrying it is pure delay.
      if (/public address/i.test(last.error ?? '')) return last;
    }
    if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }
  return last;
}

function errorText(error: unknown): string {
  return String(error instanceof Error ? error.message : error).slice(0, 1_000);
}

function jiraAutomationTarget(rawUrl: string | null): URL {
  if (!rawUrl) throw new Error('Jira Automation webhook URL is required');
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    throw new Error('Jira Automation webhook URL is invalid');
  }
  if (target.protocol !== 'https:' || target.username || target.password) {
    throw new Error('Jira Automation webhook must use HTTPS without embedded credentials');
  }
  return target;
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
