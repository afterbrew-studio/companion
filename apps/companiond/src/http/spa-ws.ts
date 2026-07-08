import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { AuthUser, SpaServerMessage } from '@companion/contract';
import { log } from '../log.js';

/**
 * The single WebSocket the browser SPA holds. companiond multiplexes every
 * live run's gateway stream onto it, tagged by runId. Browser -> server
 * traffic goes over REST (simpler auth + error surfaces); this socket is
 * strictly push.
 *
 * Auth: `?token=<session token>` — the same login session the REST API uses;
 * an expired or bogus token is refused at upgrade time.
 */
/** The bits of a run the hub needs to decide who may see its stream. */
export interface RunVisibility {
  readonly repo: string | null;
  readonly kind: string;
  readonly userId: string | null;
}

export class SpaHub {
  private readonly wss = new WebSocketServer({ noServer: true });
  /** Which user each socket authenticated as — for per-user directives. */
  private readonly owner = new WeakMap<WebSocket, string>();
  /** run id → its visibility, cached so per-message filtering avoids store hits. */
  private readonly runInfoCache = new Map<string, RunVisibility | null>();

  constructor(
    private readonly verify: (token: string | null) => AuthUser | null,
    /** Resolve a run's visibility (repo/kind/owner) for scoping its stream. */
    private readonly runInfo: (runId: string) => RunVisibility | null = () => null,
    /** Can this user (by name) see a run with this visibility? */
    private readonly canSeeRun: (username: string, info: RunVisibility) => boolean = () => true,
  ) {}

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const user = url.pathname === '/ws' ? this.verify(url.searchParams.get('token')) : null;
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.owner.set(ws, user.username);
      this.wss.emit('connection', ws, req);
      this.send(ws, { t: 'hello', version: '0.3.0' });
    });
  }

  broadcast(msg: SpaServerMessage): void {
    const raw = JSON.stringify(msg);
    // Run-stream messages (a run's record, events, turns, asks) only go to
    // users who may see that run: a private workspace's live output and one
    // user's AI Help chat must not reach others' sockets. Everything else is
    // broadcast to all.
    const info = this.runScopeOf(msg);
    for (const client of this.wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (info) {
        const username = this.owner.get(client);
        if (!username || !this.canSeeRun(username, info)) continue;
      }
      try {
        client.send(raw);
      } catch (err) {
        log.warn('dropping SPA ws send', { err: String(err) });
      }
    }
  }

  /** The run a run-scoped message belongs to (null = broadcast to all). */
  private runScopeOf(msg: SpaServerMessage): RunVisibility | null {
    if (msg.t === 'run.changed') {
      const info: RunVisibility = { repo: msg.run.repo, kind: msg.run.kind, userId: msg.run.userId };
      this.runInfoCache.set(msg.run.id, info);
      return info;
    }
    if (msg.t === 'event' || msg.t === 'turn' || msg.t === 'ask' || msg.t === 'askResolved') {
      let info = this.runInfoCache.get(msg.runId);
      if (info === undefined) {
        info = this.runInfo(msg.runId);
        this.runInfoCache.set(msg.runId, info);
      }
      return info;
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
