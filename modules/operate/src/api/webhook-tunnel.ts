import { join } from 'node:path';
import { createProxyTunnel } from '@moxxy/plugin-tunnel-proxy';
import type { TunnelHandle } from '@moxxy/sdk';
import { log, paths } from '@moxxy/companion-services';
import type { WebhookTunnelState } from '../contract/index.js';

/** One public path segment for all webhook traffic under Companion's subdomain. */
const LABEL = 'gh';
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 30_000;

type ProxyTunnelFactory = typeof createProxyTunnel;

/**
 * Public webhook delivery over moxxy's proxy relay. Opens a tunnel to
 * companiond's own HTTP port, so GitHub can reach the existing
 * `/webhooks/github/...` receiver without the user running their own tunnel.
 *
 * The subdomain derives from a persisted keypair, so the public URL is stable
 * across restarts. Enablement is the module-config flag (the truth this class
 * reconciles against): `restore()` re-opens on boot, and operate's bus
 * subscription reconciles on config changes — so an open that failed once
 * self-heals on the next boot instead of silently flipping the flag off.
 */
export class WebhookTunnel {
  private handle: TunnelHandle | null = null;
  private opening: Promise<string> | null = null;
  private lastError: string | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryMs = RETRY_MIN_MS;
  private suspended = false;

  constructor(
    /** The `webhookTunnel` module-config flag (live read). */
    private readonly relayEnabled: () => boolean,
    /** Optional operator-owned ingress, preferred over the hosted relay. */
    private readonly externalUrl: () => string,
    private readonly port: number,
    private readonly stateChanged: () => void = () => undefined,
    private readonly createTunnel: ProxyTunnelFactory = createProxyTunnel,
  ) {}

  /** Whether public delivery is validly configured right now. */
  enabled(): boolean {
    const external = this.externalIngress();
    if (external.configured) return external.url !== null;
    return this.relayEnabled();
  }

  state(): WebhookTunnelState {
    const external = this.externalIngress();
    if (external.configured) {
      return external.url
        ? { enabled: true, source: 'external', status: 'connected', url: external.url, error: null }
        : { enabled: true, source: 'external', status: 'error', url: null, error: external.error };
    }
    if (!this.relayEnabled()) {
      return { enabled: false, source: 'off', status: 'off', url: null, error: null };
    }
    if (this.handle) {
      return { enabled: true, source: 'relay', status: 'connected', url: this.handle.url, error: null };
    }
    if (this.opening) return { enabled: true, source: 'relay', status: 'connecting', url: null, error: null };
    if (this.lastError) {
      return { enabled: true, source: 'relay', status: 'error', url: null, error: this.lastError };
    }
    return { enabled: true, source: 'relay', status: 'connecting', url: null, error: null };
  }

  /** Public base URL when the tunnel is up (e.g. https://<uuid>.proxy.moxxy.ai/gh). */
  url(): string | null {
    const external = this.externalIngress();
    if (external.configured) return external.url;
    return this.handle?.url ?? null;
  }

  /** Absolute delivery URL for a receiver path, when the tunnel is up. */
  deliveryUrl(path: string): string | null {
    const base = this.url();
    return base ? `${base}${path}` : null;
  }

  async start(): Promise<string> {
    this.suspended = false;
    const external = this.externalIngress();
    if (external.configured) {
      this.clearRetry();
      if (!external.url) throw new Error(external.error ?? 'invalid self-managed webhook URL');
      // A self-managed ingress takes precedence. Close a relay left open by a
      // live config edit so two public endpoints do not remain valid silently.
      if (this.opening) await this.opening.catch(() => undefined);
      const previous = this.handle;
      this.handle = null;
      if (previous) await previous.close();
      this.lastError = null;
      this.stateChanged();
      return external.url;
    }
    if (!this.relayEnabled()) throw new Error('public webhook delivery is not configured');
    if (this.handle) return this.handle.url;
    if (this.opening) return this.opening;
    this.clearRetry();
    const attempt = (async () => {
      const provider = this.createTunnel({
        // Companion's own identity key: sharing ~/.moxxy's would make both
        // processes derive the same subdomain and collide on the relay.
        identityPath: join(paths.moxxyHome(), 'proxy-identity.key'),
        logger: {
          info: (msg, meta) => log.info(msg, meta),
          warn: (msg, meta) => log.warn(msg, meta),
        },
      });
      const handle = await provider.open({ host: '127.0.0.1', port: this.port, label: LABEL });
      this.handle = handle;
      log.info('webhook tunnel up', { url: handle.url });
      return handle.url;
    })();
    this.opening = attempt;
    this.lastError = null;
    this.stateChanged();
    try {
      const url = await attempt;
      this.retryMs = RETRY_MIN_MS;
      return url;
    } catch (err) {
      this.lastError = publicTunnelError(err);
      this.scheduleRetry();
      throw err;
    } finally {
      if (this.opening === attempt) this.opening = null;
      this.stateChanged();
    }
  }

  async stop(): Promise<void> {
    this.clearRetry();
    // Let an in-flight open land first, or its handle would be assigned after
    // the teardown and leak a public tunnel past a disable.
    if (this.opening) await this.opening.catch(() => undefined);
    const h = this.handle;
    this.handle = null;
    if (h) await h.close();
    this.lastError = null;
    this.retryMs = RETRY_MIN_MS;
    this.stateChanged();
  }

  /** Re-open on boot when the user had it enabled (the URL is key-stable). */
  restore(): void {
    this.suspended = false;
    if (!this.enabled()) {
      this.stateChanged();
      return;
    }
    void this.start().catch((err) => log.warn('webhook tunnel restore failed', { err: String(err) }));
  }

  close(): void {
    this.suspended = true;
    this.clearRetry();
    const drain = this.opening ?? Promise.resolve();
    void drain
      .catch(() => undefined)
      .then(() => {
        const h = this.handle;
        this.handle = null;
        if (h) void h.close();
      });
  }

  private scheduleRetry(): void {
    if (this.suspended || !this.relayEnabled() || this.externalIngress().configured || this.retryTimer) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.suspended || !this.relayEnabled() || this.externalIngress().configured) return;
      void this.start().catch((err) => log.warn('webhook tunnel retry failed', { err: String(err) }));
    }, delay);
    this.retryTimer.unref();
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private externalIngress(): { configured: boolean; url: string | null; error: string | null } {
    return normalizeExternalUrl(this.externalUrl());
  }
}

function normalizeExternalUrl(rawValue: string): { configured: boolean; url: string | null; error: string | null } {
  const raw = rawValue.trim();
  if (!raw) return { configured: false, url: null, error: null };
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('protocol');
    if (parsed.protocol === 'http:' && !isLoopback(parsed.hostname)) throw new Error('insecure');
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('components');
    return { configured: true, url: parsed.toString().replace(/\/+$/, ''), error: null };
  } catch {
    return {
      configured: true,
      url: null,
      error: 'The self-managed webhook URL must use HTTPS (HTTP is allowed only on loopback) and have no credentials, query, or fragment.',
    };
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

/** Public diagnostics stay useful without exposing relay internals or local paths. */
function publicTunnelError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/ECONNREFUSED|refused/i.test(message)) return 'The moxxy relay refused the connection. Retrying automatically.';
  if (/ENOTFOUND|EAI_AGAIN|resolve/i.test(message)) return 'The moxxy relay hostname could not be resolved. Retrying automatically.';
  if (/ETIMEDOUT|timed? out/i.test(message)) return 'The moxxy relay connection timed out. Retrying automatically.';
  if (/closed before registration/i.test(message)) return 'The moxxy relay closed the connection before it was ready. Retrying automatically.';
  return 'Could not connect to the moxxy relay. Retrying automatically; check the server logs for details.';
}
