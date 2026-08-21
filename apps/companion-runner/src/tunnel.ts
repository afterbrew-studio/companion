import { join } from 'node:path';
import { createProxyTunnel } from '@moxxy/plugin-tunnel-proxy';
import { paths } from '@moxxy/companion-services';
import { log } from './log.js';

/** One public path segment for everything this agent serves. */
const LABEL = 'runner';
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 60_000;

/**
 * A public https address for this machine, over moxxy's proxy relay.
 *
 * A laptop is the case this exists for: it sits behind NAT on a network nobody
 * is going to port-forward, so a Companion in the cloud cannot reach it however
 * correct its firewall rules are. The relay inverts that: the machine dials
 * out, and the daemon reaches it at a stable URL derived from a persisted key.
 *
 * The address is https, which is not incidental. The daemon refuses to put a
 * model credential, a GitHub token, an MCP definition or a tool's environment
 * on a plain-http wire, so a tunnelled runner can be sent work that a
 * directly-addressed http one cannot: everything this machine does not already
 * hold for itself.
 */
export class RunnerTunnel {
  private handle: Awaited<ReturnType<ReturnType<typeof createProxyTunnel>['open']>> | null = null;
  private opening: Promise<string> | null = null;
  private lastError: string | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryMs = RETRY_MIN_MS;
  private closed = false;

  constructor(private readonly port: number) {}

  get url(): string | null {
    return this.handle?.url ?? null;
  }

  get status(): 'off' | 'connecting' | 'connected' | 'error' {
    if (this.handle) return 'connected';
    if (this.opening) return 'connecting';
    if (this.lastError) return 'error';
    return 'off';
  }

  get error(): string | null {
    return this.lastError;
  }

  async start(): Promise<string> {
    if (this.handle) return this.handle.url;
    if (this.opening) return this.opening;
    this.clearRetry();
    const attempt = (async () => {
      const provider = createProxyTunnel({
        // This machine's own identity key, so the public URL is the same one
        // the operator registered in Companion after every restart. Sharing
        // ~/.moxxy's would make two processes derive one subdomain and collide.
        identityPath: join(paths.root(), 'proxy-identity.key'),
        logger: {
          info: (msg, meta) => log.info(msg, meta as Record<string, unknown> | undefined),
          warn: (msg, meta) => log.warn(msg, meta as Record<string, unknown> | undefined),
        },
      });
      const handle = await provider.open({ host: '127.0.0.1', port: this.port, label: LABEL });
      this.handle = handle;
      return handle.url;
    })();
    this.opening = attempt;
    this.lastError = null;
    try {
      const url = await attempt;
      this.retryMs = RETRY_MIN_MS;
      log.info(`public address: ${url}`);
      return url;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.scheduleRetry();
      throw err;
    } finally {
      if (this.opening === attempt) this.opening = null;
    }
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.clearRetry();
    // Let an in-flight open land first, or its handle would be assigned after
    // the teardown and leave a public tunnel open past the shutdown.
    if (this.opening) await this.opening.catch(() => undefined);
    const handle = this.handle;
    this.handle = null;
    if (handle) await handle.close();
  }

  private scheduleRetry(): void {
    if (this.closed || this.retryTimer) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.closed) return;
      void this.start().catch(() => undefined);
    }, delay);
    this.retryTimer.unref();
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}
