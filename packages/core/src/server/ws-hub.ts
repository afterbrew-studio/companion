import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { AuthUser, SpaServerMessage } from '@moxxy/companion-contracts';
import { log } from '@moxxy/companion-services';

/**
 * The single WebSocket the browser SPA holds. The daemon multiplexes every
 * live stream onto it. Browser -> server traffic goes over REST (simpler auth
 * + error surfaces); this socket is strictly push.
 *
 * Scoping is pluggable: a module that emits messages only some users may see
 * (e.g. operate's run streams — private-workspace output, one user's AI-Help
 * chat) registers a ScopeResolver. The first resolver claiming a message
 * decides per-user visibility; unclaimed messages broadcast to everyone.
 * Domain knowledge stays in the owning module — the hub never reaches into
 * auth/stores/orchestrators.
 *
 * Auth: `?token=<session token>` — the same login session the REST API uses;
 * an expired or bogus token is refused at upgrade time.
 */

/** May `username` see this message? */
export type MessageScope = (username: string) => boolean;

/** Claim a message (return its scope) or pass (`null` = not mine). */
export type ScopeResolver = (msg: SpaServerMessage) => MessageScope | null;

/** The registration surface exposed to modules via `ctx.ws`. */
export interface WsScopeRegistry {
  registerScopeResolver(id: string, resolver: ScopeResolver): void;
  unregisterScopeResolver(id: string): void;
}

export class WsHub implements WsScopeRegistry {
  private readonly wss = new WebSocketServer({ noServer: true });
  /** Which user each socket authenticated as — for per-user directives. */
  private readonly owner = new WeakMap<WebSocket, string>();
  private readonly resolvers = new Map<string, ScopeResolver>();

  constructor(
    private readonly verify: (token: string | null) => AuthUser | null,
    private readonly appVersion: string,
  ) {}

  registerScopeResolver(id: string, resolver: ScopeResolver): void {
    this.resolvers.set(id, resolver);
  }

  unregisterScopeResolver(id: string): void {
    this.resolvers.delete(id);
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const user = url.pathname === '/ws' ? this.verify(url.searchParams.get('token')) : null;
    // API tokens are intentionally REST-only. The socket broadcasts messages
    // by account/workspace, not by route permission, so accepting a scoped
    // credential here would silently widen its read access.
    if (!user || user.permissionScope !== undefined) {
      socket.write(`HTTP/1.1 ${user ? '403 Forbidden' : '401 Unauthorized'}\r\n\r\n`);
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.owner.set(ws, user.username);
      this.wss.emit('connection', ws, req);
      this.send(ws, { t: 'hello', version: this.appVersion });
    });
  }

  broadcast(msg: SpaServerMessage): void {
    const raw = JSON.stringify(msg);
    const scope = this.scopeOf(msg);
    for (const client of this.wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (scope) {
        const username = this.owner.get(client);
        if (!username || !scope(username)) continue;
      }
      try {
        client.send(raw);
      } catch (err) {
        log.warn('dropping SPA ws send', { err: String(err) });
      }
    }
  }

  /** First resolver claiming the message wins; unclaimed = broadcast to all. */
  private scopeOf(msg: SpaServerMessage): MessageScope | null {
    for (const resolver of this.resolvers.values()) {
      const scope = resolver(msg);
      if (scope) return scope;
    }
    return null;
  }

  /** Push to exactly the sockets a given user has open (all their tabs). */
  sendToUser(username: string, msg: SpaServerMessage): void {
    const raw = JSON.stringify(msg);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN && this.owner.get(client) === username) {
        try {
          client.send(raw);
        } catch (err) {
          log.warn('dropping SPA ws send', { err: String(err) });
        }
      }
    }
  }

  private send(ws: WebSocket, msg: SpaServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // ignore
    }
  }

  close(): void {
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
  }
}
