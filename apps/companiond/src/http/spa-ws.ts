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
export class SpaHub {
  private readonly wss = new WebSocketServer({ noServer: true });
  /** Which user each socket authenticated as — for per-user directives. */
  private readonly owner = new WeakMap<WebSocket, string>();
  /** run id → repo, cached so per-message filtering doesn't hit the store per token. */
  private readonly runRepoCache = new Map<string, string | null>();

  constructor(
    private readonly verify: (token: string | null) => AuthUser | null,
    /** Resolve a run's repo (for scoping run-stream messages). */
    private readonly runRepo: (runId: string) => string | null = () => null,
    /** Can this user (by name) see this repo? Gates run-scoped messages. */
    private readonly canSeeRepo: (username: string, repo: string) => boolean = () => true,
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
    // Run-stream messages (a run's events/turns/asks or its record) only go to
    // users who can see that run's repo — a private workspace's live output
    // must not reach non-members' sockets. Non-run messages go to everyone.
    const repo = this.repoScopeOf(msg);
    for (const client of this.wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (repo) {
        const username = this.owner.get(client);
        if (!username || !this.canSeeRepo(username, repo)) continue;
      }
      try {
        client.send(raw);
      } catch (err) {
        log.warn('dropping SPA ws send', { err: String(err) });
      }
    }
  }

  /** The repo a run-scoped message belongs to (null = broadcast to all). */
  private repoScopeOf(msg: SpaServerMessage): string | null {
    if (msg.t === 'run.changed') {
      this.runRepoCache.set(msg.run.id, msg.run.repo);
      return msg.run.repo;
    }
    if (msg.t === 'event' || msg.t === 'turn' || msg.t === 'ask' || msg.t === 'askResolved') {
      let repo = this.runRepoCache.get(msg.runId);
      if (repo === undefined) {
        repo = this.runRepo(msg.runId);
        this.runRepoCache.set(msg.runId, repo);
      }
      return repo;
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
