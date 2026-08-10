import { z } from 'zod';
import { withPublicHttpResponse } from '@moxxy/companion-sdk/server';
import type { IntegrationConnectionAccess } from '@companion/module-integrations/provider';
import type { JiraIssueSnapshot, JiraTransition } from '../contract/index.js';

const issueSchema = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9_]{0,39}-[1-9]\d{0,11}$/),
  fields: z.object({
    summary: z.string().max(5_000),
    status: z.object({
      name: z.string().max(200),
      statusCategory: z.object({ name: z.string().max(200) }).nullish(),
    }),
    issuetype: z.object({ name: z.string().max(200) }),
  }),
});

const transitionsSchema = z.object({
  transitions: z.array(
    z.object({
      id: z.string().regex(/^\d{1,12}$/),
      name: z.string().max(200),
      to: z.object({
        name: z.string().max(200),
        statusCategory: z.object({ name: z.string().max(200) }).nullish(),
      }),
    }),
  ).max(200),
});

export class JiraCloudClient {
  private readonly baseUrl: string;
  private readonly authorization: string;

  constructor(private readonly connection: IntegrationConnectionAccess) {
    const baseUrl = connection.record.config.baseUrl;
    const email = connection.record.config.email;
    const token = connection.secret('apiToken');
    if (typeof baseUrl !== 'string' || typeof email !== 'string' || !token) {
      throw new Error('Jira Cloud connection is missing its site URL, email or API token');
    }
    this.baseUrl = jiraSiteOrigin(baseUrl);
    this.authorization = `Basic ${Buffer.from(`${email}:${token}`, 'utf8').toString('base64')}`;
  }

  async me(): Promise<void> {
    await this.request('/rest/api/3/myself');
  }

  async issue(rawKey: string): Promise<JiraIssueSnapshot> {
    const key = normalizeIssueKey(rawKey);
    const value = issueSchema.parse(
      await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status,issuetype`),
    );
    return {
      key: value.key,
      summary: value.fields.summary,
      status: value.fields.status.name,
      statusCategory: value.fields.status.statusCategory?.name ?? null,
      issueType: value.fields.issuetype.name,
      url: `${this.baseUrl}/browse/${encodeURIComponent(value.key)}`,
    };
  }

  async comment(rawKey: string, text: string): Promise<void> {
    const key = normalizeIssueKey(rawKey);
    await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
      method: 'POST',
      body: JSON.stringify({
        body: {
          type: 'doc',
          version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
        },
      }),
    });
  }

  async transitions(rawKey: string): Promise<JiraTransition[]> {
    const key = normalizeIssueKey(rawKey);
    const value = transitionsSchema.parse(
      await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`),
    );
    return value.transitions.map((transition) => ({
      id: transition.id,
      name: transition.name,
      toStatus: transition.to.name,
      toCategory: transition.to.statusCategory?.name ?? null,
    }));
  }

  async transition(rawKey: string, transitionId: string): Promise<void> {
    const key = normalizeIssueKey(rawKey);
    if (!/^\d{1,12}$/.test(transitionId)) throw new Error('invalid Jira transition id');
    await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      method: 'POST',
      body: JSON.stringify({ transition: { id: transitionId } }),
    });
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    return withPublicHttpResponse(
      `${this.baseUrl}${path}`,
      {
        ...init,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: this.authorization,
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(15_000),
        redirect: 'manual',
      },
      async (response) => {
        const text = await readBoundedText(response, 2_000_000);
        if (!response.ok) {
          throw new Error(`Jira returned ${response.status}: ${jiraError(text)}`);
        }
        if (!text.trim()) return null;
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new Error('Jira returned invalid JSON');
        }
      },
    );
  }
}

export function jiraSiteOrigin(baseUrl: string): string {
  let site: URL;
  try {
    site = new URL(baseUrl);
  } catch {
    throw new Error('Jira site URL is invalid');
  }
  if (site.protocol !== 'https:' || site.username || site.password) {
    throw new Error('Jira site URL must be an HTTPS origin without embedded credentials');
  }
  if (site.pathname !== '/' || site.search || site.hash) {
    throw new Error('Jira site URL must be the site origin, for example https://company.atlassian.net');
  }
  if (!site.hostname.toLowerCase().endsWith('.atlassian.net')) {
    throw new Error('Jira Cloud site must use an atlassian.net hostname');
  }
  return site.origin;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new Error('Jira response exceeded the 2 MB safety limit');
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error('Jira response exceeded the 2 MB safety limit');
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export function normalizeIssueKey(value: string): string {
  const key = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{0,39}-[1-9]\d{0,11}$/.test(key)) {
    throw new Error('Jira issue key must look like PROJECT-123');
  }
  return key;
}

function jiraError(text: string): string {
  try {
    const value = z
      .object({
        errorMessages: z.array(z.string().max(1_000)).max(100).optional(),
        errors: z.record(z.string().max(1_000)).optional(),
      })
      .parse(JSON.parse(text));
    return ([...(value.errorMessages ?? []), ...Object.values(value.errors ?? {})].join('; ') || 'request failed')
      .slice(0, 500);
  } catch {
    return text.trim().slice(0, 500) || 'request failed';
  }
}
