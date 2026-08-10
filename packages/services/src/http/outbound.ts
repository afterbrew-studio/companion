import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { log } from '../lib/log.js';

/** The variables a corporate environment sets; `EnvHttpProxyAgent` reads all of them. */
const PROXY_VARS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy'] as const;

const configured = (): string | null => {
  for (const name of PROXY_VARS) {
    const value = process.env[name]?.trim();
    // The URL can contain proxy credentials. The variable name is enough for
    // diagnostics and does not turn the daemon log into a secret store.
    if (value) return name;
  }
  return null;
};

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
  ['240.0.0.0', 4],
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2002::', 16],
  ['fc00::', 7],
  ['fec0::', 10],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, 'ipv6');
}

export type ResolveAddresses = (hostname: string) => Promise<readonly string[]>;

const resolveAddresses: ResolveAddresses = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

export function isPublicAddress(address: string): boolean {
  const plain = address.split('%')[0] ?? address;
  const family = isIP(plain);
  return family !== 0 && !NON_PUBLIC.check(plain, family === 4 ? 'ipv4' : 'ipv6');
}

/** Resolve every answer once and reject local, private, metadata and transition ranges. */
export async function assertPublicHttpTarget(
  raw: string | URL,
  resolve: ResolveAddresses = resolveAddresses,
): Promise<readonly string[]> {
  const target = raw instanceof URL ? raw : new URL(raw);
  if ((target.protocol !== 'https:' && target.protocol !== 'http:') || target.username || target.password) {
    throw new Error('outbound target must use HTTP(S) without embedded credentials');
  }
  const hostname = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.home.arpa')
  ) {
    throw new Error('outbound target must be publicly reachable');
  }
  const literal = isIP(hostname);
  const addresses = literal ? [hostname] : await resolve(hostname);
  if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
    throw new Error('outbound target must resolve only to public addresses');
  }
  return addresses;
}

export interface PublicHttpOptions {
  /** Test seam only. Production callers leave this unset. */
  readonly fetchImpl?: typeof fetch;
  /** Test seam only. Production callers leave this unset. */
  readonly resolveAddresses?: ResolveAddresses;
}

/**
 * Execute an outbound HTTP request against the exact public address that was
 * validated. Keeping response consumption inside the callback keeps the pinned
 * dispatcher alive until the body is either read or cancelled.
 */
export async function withPublicHttpResponse<T>(
  raw: string | URL,
  init: RequestInit,
  consume: (response: Response) => Promise<T>,
  opts: PublicHttpOptions = {},
): Promise<T> {
  const url = String(raw);
  const addresses = await assertPublicHttpTarget(url, opts.resolveAddresses ?? resolveAddresses);
  const fetchImpl = opts.fetchImpl ?? fetch;
  if (opts.fetchImpl) return consume(await fetchImpl(url, init));

  if (configured()) {
    if (process.env.COMPANION_TRUST_EGRESS_PROXY !== '1') {
      throw new Error(
        'public outbound delivery through an HTTP proxy requires COMPANION_TRUST_EGRESS_PROXY=1 and proxy-side SSRF policy',
      );
    }
    return consume(await fetchImpl(url, init));
  }

  const address = addresses[0]!;
  const family = isIP(address) as 4 | 6;
  const dispatcher = new Agent({
    connect: {
      lookup: (_hostname, _options, callback) => callback(null, address, family),
    },
  });
  try {
    const response = await undiciFetch(
      url,
      { ...init, dispatcher } as unknown as NonNullable<Parameters<typeof undiciFetch>[1]>,
    );
    return await consume(response as unknown as Response);
  } finally {
    await dispatcher.close();
  }
}

/**
 * Route every outbound request through the environment's proxy.
 *
 * Node's `fetch` ignores `HTTP_PROXY` / `HTTPS_PROXY` on its own, so on a network
 * with a mandatory egress proxy every GitHub call fails with nothing to turn.
 * `setGlobalDispatcher` from the npm `undici` does reach the built-in `fetch`
 * (verified against a CONNECT proxy on Node 24), which is why this needs no
 * changes at any call site.
 *
 * Installed ONLY when a proxy variable is actually set: swapping the dispatcher
 * for everyone would put a new component on the request path of the majority who
 * have no proxy at all, for no benefit. `NO_PROXY` is honoured by the agent.
 *
 * `undici` is imported lazily so that an instance with no proxy, and the CLI
 * (which pulls this package for its paths), never load it at all.
 *
 * Call once, at daemon boot, before any module loads.
 */
export async function installOutboundProxy(): Promise<void> {
  const source = configured();
  if (!source) return;
  const { EnvHttpProxyAgent, setGlobalDispatcher } = await import('undici');
  setGlobalDispatcher(new EnvHttpProxyAgent());
  log.info(`outbound requests go through the proxy configured by ${source}`);
}
