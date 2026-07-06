import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './log.js';
import { loadDaemonConfig, paths } from './config.js';
import { detectMoxxyCli, MIN_MOXXY_VERSION } from './moxxy/cli.js';
import { seedPermissionDenyRules } from './moxxy/home.js';
import { Orchestrator } from './runs/orchestrator.js';
import { Store } from './store/db.js';
import { SpaHub } from './http/spa-ws.js';
import { startHttpServer } from './http/server.js';

async function main(): Promise<void> {
  const config = loadDaemonConfig();
  seedPermissionDenyRules();

  const moxxyCli = await detectMoxxyCli(paths.moxxyHome(), config.moxxyCliPath);
  if (!moxxyCli) {
    log.warn(
      `moxxy CLI not found on PATH — install it with: npm i -g @moxxy/cli  (>= ${MIN_MOXXY_VERSION}). ` +
        'companiond starts anyway; runs will fail until moxxy is installed.',
    );
  } else if (!moxxyCli.compatible) {
    log.warn(
      `installed moxxy ${moxxyCli.version} is older than the supported ${MIN_MOXXY_VERSION}; upgrade with: npm i -g @moxxy/cli`,
    );
  } else {
    log.info(`moxxy ${moxxyCli.version} at ${moxxyCli.path}`);
  }

  const store = new Store();
  const hub = new SpaHub(config.spaToken);
  const orchestrator = new Orchestrator(store, config, moxxyCli?.path ?? 'moxxy', (msg) =>
    hub.broadcast(msg),
  );
  orchestrator.recover();

  // Serve the built SPA when present (production); dev uses Vite + proxy.
  const here = dirname(fileURLToPath(import.meta.url));
  const builtSpa = join(here, '..', '..', 'web', 'dist');
  const server = await startHttpServer({
    port: config.port,
    deps: { config, orchestrator, moxxyCli },
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
    await orchestrator.shutdown();
    hub.close();
    server.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  log.error('fatal boot error', err);
  process.exit(1);
});
