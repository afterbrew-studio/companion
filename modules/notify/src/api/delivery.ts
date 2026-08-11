import { createHmac } from 'node:crypto';
import type { NotificationRecord } from '@companion/module-workspace/contract';
import {
  assertPublicHttpTarget,
  isPublicAddress,
  withPublicHttpResponse,
  type ResolveAddresses,
} from '@moxxy/companion-sdk/server';

export { isPublicAddress };

export type NotificationProviderKind = 'webhook' | 'slack' | 'discord' | 'teams' | 'ntfy';

/** One attempt gets this long before it is abandoned as unreachable. */
const REQUEST_TIMEOUT_MS = 10_000;
/** A transient failure is retried once, after this pause. */
const RETRY_DELAY_MS = 2_000;

/** Refuse a personal destination that can reach the daemon, LAN, metadata or another private service. */
export async function assertPublicDeliveryTarget(
  raw: string,
  resolve?: ResolveAddresses,
): Promise<readonly string[]> {
  return assertPublicHttpTarget(raw, resolve);
}

export interface DeliveryOutcome {
  readonly ok: boolean;
  readonly httpStatus: number | null;
  readonly error: string | null;
  readonly attempts: number;
}

export interface OutboundRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** An absolute link to the notification's page, when the instance knows its own URL. */
function absoluteHref(notification: NotificationRecord, publicUrl: string | null): string | null {
  if (!notification.href) return null;
  if (!publicUrl) return null;
  return `${publicUrl.replace(/\/+$/, '')}/${notification.href.replace(/^\/+/, '')}`;
}

function plainText(notification: NotificationRecord, link: string | null): string {
  const body = notification.body.trim();
  return [notification.title, body, link].filter(Boolean).join('\n');
}

/**
 * Turn one notification into the request a given channel kind expects. Pure, so
 * the shape of every payload is asserted in tests without a network.
 *
 * The generic `webhook` kind sends the whole record as JSON and signs it the
 * way GitHub does (`sha256=<hex>` HMAC over the exact bytes sent), because that
 * is a verification recipe every receiver already has code for.
 */
export function buildRequest(
  kind: NotificationProviderKind,
  url: string,
  notification: NotificationRecord,
  opts: { publicUrl?: string | null; secret?: string | null } = {},
): OutboundRequest {
  const link = absoluteHref(notification, opts.publicUrl ?? null);
  const json = (target: string, payload: unknown): OutboundRequest => ({
    url: target,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  switch (kind) {
    case 'slack':
      return json(url, { text: plainText(notification, link) });
    case 'discord':
      return json(url, { content: plainText(notification, link).slice(0, 1900) });
    case 'teams': {
      // Both Teams webhook generations, the legacy *.webhook.office.com
      // connectors and their Power Automate Workflows replacement on
      // *.logic.azure.com, accept an Adaptive Card wrapped in a `message`
      // attachment envelope, so one payload serves either URL.
      const card: Record<string, unknown> = {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        msteams: { width: 'Full' },
        body: [
          { type: 'TextBlock', size: 'Medium', weight: 'Bolder', text: notification.title, wrap: true },
          ...(notification.body.trim()
            ? [{ type: 'TextBlock', text: notification.body, wrap: true }]
            : []),
        ],
        ...(link ? { actions: [{ type: 'Action.OpenUrl', title: 'Open in Companion', url: link }] } : {}),
      };
      return json(url, {
        type: 'message',
        attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }],
      });
    }
    case 'ntfy': {
      // ntfy takes the topic in the URL path; posting JSON to the origin with an
      // explicit `topic` avoids putting the title in a header, where non-ASCII
      // would have to be encoded by hand.
      const parsed = new URL(url);
      const topic = parsed.pathname.split('/').filter(Boolean)[0] ?? '';
      return json(parsed.origin, {
        topic,
        title: notification.title,
        message: notification.body || notification.title,
        ...(link ? { click: link } : {}),
      });
    }
    case 'webhook': {
      const body = JSON.stringify({
        id: notification.id,
        kind: notification.kind,
        title: notification.title,
        body: notification.body,
        workspaceId: notification.workspaceId,
        repo: notification.repo,
        href: notification.href,
        url: link,
        createdAt: notification.createdAt,
      });
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (opts.secret) {
        headers['x-companion-signature-256'] = `sha256=${createHmac('sha256', opts.secret).update(body).digest('hex')}`;
      }
      return { url, headers, body };
    }
  }
}

/** 429 and 5xx are the receiver having a moment; 4xx is us being wrong. */
function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * POST the request, retrying once on a transient failure. Never throws: a
 * destination being down is data to record, not an exception to propagate into
 * the operation that raised the notification.
 *
 * Requests go through the daemon's global dispatcher, so an instance behind
 * HTTPS_PROXY reaches Slack the same way it reaches GitHub.
 */
export async function deliver(
  request: OutboundRequest,
  fetchImpl: typeof fetch = fetch,
  opts: { publicOnly?: boolean; resolveAddresses?: ResolveAddresses } = {},
): Promise<DeliveryOutcome> {
  let last: DeliveryOutcome = { ok: false, httpStatus: null, error: 'not attempted', attempts: 0 };
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const init: RequestInit = {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        // A redirect would be a second, unvalidated destination and is never
        // required by webhook providers. Store the 3xx as a visible failure.
        redirect: 'manual',
      };
      const res = opts.publicOnly
        ? await publicFetch(request.url, init, fetchImpl, opts.resolveAddresses)
        : await fetchImpl(request.url, init);
      // Webhook response bodies are not part of the contract. Cancel them so a
      // noisy or malicious receiver cannot retain an idle socket/body stream.
      await res.body?.cancel().catch(() => undefined);
      if (res.ok) return { ok: true, httpStatus: res.status, error: null, attempts: attempt };
      last = {
        ok: false,
        httpStatus: res.status,
        error: `${res.status} ${res.statusText}`.trim(),
        attempts: attempt,
      };
      if (!retryable(res.status)) return last;
    } catch (err) {
      last = {
        ok: false,
        httpStatus: null,
        error: String(err instanceof Error ? err.message : err).slice(0, 300),
        attempts: attempt,
      };
      if (opts.publicOnly && /public|personal notification target/i.test(last.error ?? '')) return last;
    }
    if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }
  return last;
}

/**
 * Validate DNS and use that exact address for the connection. Re-resolving in
 * `fetch` after validation is a DNS-rebinding TOCTOU; an undici Agent with a
 * pinned lookup closes it while retaining the original Host header and TLS SNI.
 *
 * A configured proxy owns DNS instead. It is accepted only through an explicit
 * trust switch, so deployments cannot silently trade the local guarantee for
 * an arbitrary corporate proxy configuration.
 */
async function publicFetch(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  resolve?: ResolveAddresses,
): Promise<Pick<Response, 'ok' | 'status' | 'statusText' | 'body'>> {
  return withPublicHttpResponse(
    url,
    init,
    async (response) => {
      await response.body?.cancel().catch(() => undefined);
      return { ok: response.ok, status: response.status, statusText: response.statusText, body: null };
    },
    { ...(fetchImpl === fetch ? {} : { fetchImpl }), ...(resolve ? { resolveAddresses: resolve } : {}) },
  );
}
