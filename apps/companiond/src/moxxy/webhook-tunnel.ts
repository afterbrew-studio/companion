import { join } from 'node:path';
import { createProxyTunnel } from '@moxxy/plugin-tunnel-proxy';
import type { TunnelHandle } from '@moxxy/sdk';
import { log } from '../log.js';
import { paths } from '../config.js';
import type { Store } from '../store/db.js';

/** One public path segment for all webhook traffic under Companion's subdomain. */
const LABEL = 'gh';

/**
 * Public webhook delivery over moxxy's proxy relay. Opens a tunnel to
 * companiond's own HTTP port, so GitHub can reach the existing
 * `/webhooks/github/...` receiver without the user running their own tunnel.
 *
 * The subdomain derives from a persisted keypair, so the public URL is stable
 * across restarts; enablement is remembered in settings and restored on boot.
 */
export class WebhookTunnel {
  private handle: TunnelHandle | null = null;
  private opening: Promise<string> | null = null;

  constructor(
    private readonly store: Store,
    private readonly port: number,
  ) {}

  /** Public base URL when the tunnel is up (e.g. https://<uuid>.proxy.moxxy.ai/gh). */
  url(): string | null {
    return this.handle?.url ?? null;
  }

  enabled(): boolean {
    return this.store.settings.get('webhookTunnel') === 'on';
  }

  /** Absolute delivery URL for a receiver path, when the tunnel is up. */
  deliveryUrl(path: string): string | null {
    const base = this.url();
    return base ? `${base}${path}` : null;
  }

  async start(): Promise<string> {
    if (this.handle) return this.handle.url;
    if (this.opening) return this.opening;
    this.opening = (async () => {
      const provider = createProxyTunnel({
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
      this.store.settings.set('webhookTunnel', 'on');
      log.info('webhook tunnel up', { url: handle.url });
      return handle.url;
    })();
    try {
      return await this.opening;
    } finally {
      this.opening = null;
    }
  }

  async stop(): Promise<void> {
    this.store.settings.set('webhookTunnel', '');
    const h = this.handle;
    this.handle = null;
    if (h) await h.close();
  }

  /** Re-open on boot when the user had it enabled (the URL is key-stable). */
  restore(): void {
    if (!this.enabled()) return;
    void this.start().catch((err) => log.warn('webhook tunnel restore failed', { err: String(err) }));
  }

  close(): void {
    const h = this.handle;
    this.handle = null;
    if (h) void h.close();
  }
}
