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
        kind: 'text',
        placeholder: 'action_required,error,finished',
        description: 'Optional comma-separated filter. Empty delivers every notification kind.',
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

async function sendAutomation(
  connection: IntegrationConnectionAccess,
  notification: IntegrationNotificationInput,
) {
  const url = connection.secret('url');
  if (!url) return { ok: false, httpStatus: null, error: 'webhook URL is not configured', attempts: 0 };
  const token = connection.secret('token');
  try {
    const target = jiraAutomationTarget(url);
    const response = await fetch(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-automation-webhook-token': token } : {}),
      },
      body: JSON.stringify(notification),
      signal: AbortSignal.timeout(10_000),
      redirect: 'manual',
    });
    await response.body?.cancel().catch(() => undefined);
    return {
      ok: response.ok,
      httpStatus: response.status,
      error: response.ok ? null : `Jira Automation returned ${response.status}`,
      attempts: 1,
    };
  } catch (error) {
    return {
      ok: false,
      httpStatus: null,
      error: String(error instanceof Error ? error.message : error).slice(0, 1_000),
      attempts: 1,
    };
  }
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

const NOTIFICATION_KINDS = new Set(['action_required', 'finished', 'error', 'info']);

function eventKinds(value: string): Set<string> {
  return new Set(value.split(',').map((kind) => kind.trim()).filter(Boolean));
}

function validateEventKinds(value: unknown): void {
  if (value === undefined || value === '') return;
  if (typeof value !== 'string') throw new Error('Event kinds must be comma-separated text');
  const unsupported = [...eventKinds(value)].filter((kind) => !NOTIFICATION_KINDS.has(kind));
  if (unsupported.length > 0) throw new Error(`Unsupported event kind: ${unsupported.join(', ')}`);
}
