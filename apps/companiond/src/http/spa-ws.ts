import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { SpaServerMessage } from '@companion/contract';
import { log } from '../log.js';

/**
 * The single WebSocket the browser SPA holds. companiond multiplexes every live
 * run's gateway stream onto it, tagged by runId. Browser -> server traffic goes
 * over REST (simpler auth + error surfaces); this socket is strictly push.
 *
 * Auth: `?token=<spaToken>` query. The server binds 127.0.0.1 only and the
 * token is minted per install, so the exposure window is other local processes
 * — same trust stance as moxxy's own loopback bridges.
 */
export class SpaHub {
  private readonly wss = new WebSocketServer({ noServer: true });

  constructor(private readonly token: string) {}

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws' || url.searchParams.get('token') !== this.token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req);
      this.send(ws, { t: 'hello', version: '0.1.0' });
    });
  }

  broadcast(msg: SpaServerMessage): void {
    const raw = JSON.stringify(msg);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
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
