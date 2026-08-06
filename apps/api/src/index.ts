import { chmodSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  consumePendingDbRecreate,
  Database,
  InstanceLock,
  installOutboundProxy,
  loadDaemonConfig,
  log,
  paths,
} from '@moxxy/companion-services';
import {
  installAbiBridge,
  loadExternalModules,
  ModuleKernel,
  scanExternalModules,
  WsHub,
} from '@moxxy/companion-core/server';
import * as sdk from '@moxxy/companion-sdk';
import { SDK_VERSION } from '@moxxy/companion-sdk';
import * as sdkServer from '@moxxy/companion-sdk/server';
import * as sdkAgents from '@moxxy/companion-sdk/agents';
import { MODULES } from './modules.generated.js';
import { startHttpServer } from './http/server.js';
import { COMPANION_VERSION } from './version.js';

/**
 * The api daemon's composition root — now just: config, database, WebSocket
 * hub, kernel boot over the static module registry, HTTP server, shutdown.
 * Everything domain-shaped (services, routes, migrations, permissions, jobs,
 * cross-module reactions) lives in the modules the kernel loads.
 */
async function main(): Promise<void> {
  // The database, WAL, setup files, and run artifacts may contain credentials.
  // Keep every file created by the daemon private to the OS user by default.
  process.umask(0o077);
  // Before anything reaches the network: on a network with a mandatory egress
  // proxy, every outbound call fails without this and there is nothing to turn.
  await installOutboundProxy();
  const config = loadDaemonConfig();
  log.info(`Companion ${COMPANION_VERSION}`);
  log.info(`accounts: ${config.users.map((u) => `${u.username} (${u.role})`).join(', ')}`);
  log.info('agent model selection: runtime default unless explicitly pinned');

  // An admin-requested database recreation is honored here, before the handle
  // opens: the previous process dropped the marker and exited; this boot starts
  // from a clean slate and first-boot setup runs again.
  if (consumePendingDbRecreate()) log.warn('recreate-db marker found — starting with a fresh database');

  // Before the database opens: one daemon per COMPANION_HOME. Companion is a
  // single-node appliance and the home holds clones, worktrees and the moxxy
  // home, so a second daemon would duplicate every scheduled job and fight over
  // the same checkouts. Refuse rather than corrupt.
  const lock = new InstanceLock();
  await lock.acquire();

  const dbPath = paths.db();
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(file)) chmodSync(file, 0o600);
  }

  // The hub authenticates upgrades through the kernel (module-core's Auth once
  // booted); the kernel pushes through the hub. Both closures run post-boot.
  // Before any external module is imported: the bridge is what makes the SDK it
  // resolves the SAME objects this process is using, so `instanceof Reply` holds
  // across the boundary. See abi-bridge.ts for why a symlink cannot do this.
  installAbiBridge({
    dir: paths.externalModules(),
    version: SDK_VERSION,
    namespaces: {
      '.': sdk as unknown as Record<string, unknown>,
      './server': sdkServer as unknown as Record<string, unknown>,
      './agents': sdkAgents as unknown as Record<string, unknown>,
    },
  });
  const scan = scanExternalModules(paths.externalModules());
  // Resolved once, from validated metadata, so the HTTP layer never joins a
  // request path against a directory.
  const moduleChunks = new Map(
    scan.modules.filter((m) => m.meta.client).map((m) => [m.meta.id, join(m.dir, m.meta.client!)]),
  );
  for (const p of scan.problems) log.warn(`skipping external module '${p.dir}': ${p.reason}`);
  const external = await loadExternalModules(scan.modules, (id, err) =>
    log.error(`external module '${id}' failed to load`, err),
  );
  if (external.length) log.info(`external modules: ${external.map((m) => m.manifest.id).join(', ')}`);

  const hub: WsHub = new WsHub((token) => kernel.verifyToken(token), COMPANION_VERSION);
  const kernel = new ModuleKernel({
    appVersion: COMPANION_VERSION,
    db,
    log,
    config,
    modules: [...MODULES, ...external],
    broadcast: (msg) => hub.broadcast(msg),
    pushToUser: (username, msg) => hub.sendToUser(username, msg),
    ws: hub,
  });
  await kernel.boot();

  // Serve the built SPA when present (production); dev uses Vite + proxy.
  const here = dirname(fileURLToPath(import.meta.url));
  const builtSpa = process.env.COMPANION_STATIC_DIR?.trim() || join(here, '..', '..', 'web', 'dist');
  const server = await startHttpServer({
    host: config.host,
    port: config.port,
    kernel,
    hub,
    staticDir: existsSync(join(builtSpa, 'index.html')) ? builtSpa : undefined,
    moduleChunks,
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
    // Last, so the lock means "this home is in use" for as long as it is: a
    // successor started by an admin restart waits on exactly this, and releasing
    // before the port closes would hand it a home it cannot bind. A hung
    // shutdown that hits the force-exit above leaves the file behind, which the
    // next daemon sees as a dead pid and takes over.
    lock.release();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  log.error('fatal boot error', err);
  process.exit(1);
});
