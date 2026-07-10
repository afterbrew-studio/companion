import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { consumePendingDbRecreate, loadDaemonConfig, log, paths } from '@companion/services';
import { ModuleKernel, WsHub } from '@companion/core/server';
import { MODULES } from './modules.js';
import { startHttpServer } from './http/server.js';

/**
 * The api daemon's composition root — now just: config, database, WebSocket
 * hub, kernel boot over the static module registry, HTTP server, shutdown.
 * Everything domain-shaped (services, routes, migrations, permissions, jobs,
 * cross-module reactions) lives in the modules the kernel loads.
 */
async function main(): Promise<void> {
  const config = loadDaemonConfig();
  log.info(`accounts: ${config.users.map((u) => `${u.username} (${u.role})`).join(', ')}`);
  log.info(`default agent model: ${config.defaultModel}`);

  // An admin-requested database recreation is honored here, before the handle
  // opens: the previous process dropped the marker and exited; this boot starts
  // from a clean slate and first-boot setup runs again.
  if (consumePendingDbRecreate()) log.warn('recreate-db marker found — starting with a fresh database');

  const db = new Database(paths.db());
  db.pragma('journal_mode = WAL');

  // The hub authenticates upgrades through the kernel (module-core's Auth once
  // booted); the kernel pushes through the hub. Both closures run post-boot.
  const hub: WsHub = new WsHub((token) => kernel.verifyToken(token));
  const kernel = new ModuleKernel({
    db,
    log,
    config,
    modules: MODULES,
    broadcast: (msg) => hub.broadcast(msg),
    pushToUser: (username, msg) => hub.sendToUser(username, msg),
    ws: hub,
  });
  await kernel.boot();

  // Serve the built SPA when present (production); dev uses Vite + proxy.
  const here = dirname(fileURLToPath(import.meta.url));
  const builtSpa = join(here, '..', '..', 'web', 'dist');
  const server = await startHttpServer({
    host: config.host,
    port: config.port,
    kernel,
    hub,
    staticDir: existsSync(join(builtSpa, 'index.html')) ? builtSpa : undefined,
  });

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down…');
    const force = setTimeout(() => process.exit(0), 6_000);
    force.unref();
    await kernel.shutdown();
    hub.close();
    server.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  log.error('fatal boot error', err);
  process.exit(1);
});
