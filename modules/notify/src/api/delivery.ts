import { createHmac } from 'node:crypto';
import type { NotificationRecord } from '@companion/module-workspace/contract';
import type { NotifyChannelKind } from '../contract/index.js';

/** One attempt gets this long before it is abandoned as unreachable. */
const REQUEST_TIMEOUT_MS = 10_000;
/** A transient failure is retried once, after this pause. */
const RETRY_DELAY_MS = 2_000;

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

/**
 * A destination URL is a credential: a Slack webhook URL is enough to post into
 * that channel. Only host and a hint of the path are ever shown, so an
 * over-the-shoulder screenshot of the settings page leaks nothing usable.
 * A malformed URL is reported as such rather than echoed back.
 */
export function redactTarget(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const head = segments.length > 0 ? `/${segments[0]}` : '';
    return `${parsed.host}${head}${segments.length > 1 ? '/…' : ''}`;
  } catch {
    return 'invalid URL';
  }
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
  kind: NotifyChannelKind,
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
): Promise<DeliveryOutcome> {
  let last: DeliveryOutcome = { ok: false, httpStatus: null, error: 'not attempted', attempts: 0 };
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetchImpl(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
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
    }
    if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }
  return last;
}
