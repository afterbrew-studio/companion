import { log } from '../lib/log.js';

/** The variables a corporate environment sets; `EnvHttpProxyAgent` reads all of them. */
const PROXY_VARS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy'] as const;

const configured = (): string | null => {
  for (const name of PROXY_VARS) {
    const value = process.env[name]?.trim();
    if (value) return `${name}=${value}`;
  }
  return null;
};

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
  log.info(`outbound requests go through the proxy from ${source}`);
}
