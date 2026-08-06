import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { NotificationRecord } from '@companion/module-workspace/contract';

export type NotificationProviderKind = 'webhook' | 'slack' | 'discord' | 'ntfy';

/** One attempt gets this long before it is abandoned as unreachable. */
const REQUEST_TIMEOUT_MS = 10_000;
/** A transient failure is retried once, after this pause. */
const RETRY_DELAY_MS = 2_000;

const NON_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, 'ipv6');
}

// Node's BlockList maps IPv4 addresses through the IPv6 table while checking
// them. Adding the whole ::ffff:0:0/96 range would therefore classify *every*
// IPv4 destination as private. The IPv4 ranges above already match their
// IPv4-mapped IPv6 forms, so no blanket mapped range belongs here.

export function isPublicAddress(address: string): boolean {
  const plain = address.split('%')[0] ?? address;
  const family = isIP(plain);
  return family !== 0 && !NON_PUBLIC.check(plain, family === 4 ? 'ipv4' : 'ipv6');
}

type ResolveAddresses = (hostname: string) => Promise<readonly string[]>;

const resolveAddresses: ResolveAddresses = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

/** Refuse a personal destination that can reach the daemon, LAN, metadata or another private service. */
export async function assertPublicDeliveryTarget(
  raw: string,
  resolve: ResolveAddresses = resolveAddresses,
): Promise<void> {
  const target = new URL(raw);
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    throw new Error('personal notification target must use http or https');
  }
  const hostname = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.home.arpa')
  ) {
    throw new Error('personal notification target must be publicly reachable');
  }
  const literal = isIP(hostname);
  const addresses = literal ? [hostname] : await resolve(hostname);
  if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
    throw new Error('personal notification target must resolve only to public addresses');
  }
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
      if (opts.publicOnly) {
        await assertPublicDeliveryTarget(request.url, opts.resolveAddresses ?? resolveAddresses);
      }
      const res = await fetchImpl(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        // A redirect would be a second, unvalidated destination and is never
        // required by webhook providers. Store the 3xx as a visible failure.
        redirect: 'manual',
      });
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
