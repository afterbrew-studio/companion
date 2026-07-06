import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './log.js';
import { loadDaemonConfig, paths } from './config.js';
import { detectMoxxyCli, MIN_MOXXY_VERSION } from './moxxy/cli.js';
import { seedPermissionDenyRules } from './moxxy/home.js';
import { Orchestrator } from './runs/orchestrator.js';
import { Fixes } from './runs/fixes.js';
import { Store } from './store/db.js';
import { SpaHub } from './http/spa-ws.js';
import { startHttpServer } from './http/server.js';
import { GitHubClient } from './github/client.js';
import { GitHubSync } from './github/sync.js';
import { Checkouts } from './git/checkouts.js';
import { Triage } from './triage/triage.js';
import { PrReviews } from './prs/reviews.js';
import { Proposals } from './proposals/proposals.js';
import { Automations } from './automations/automations.js';
import { Skills } from './skills/skills.js';

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
    log.warn(`installed moxxy ${moxxyCli.version} is older than ${MIN_MOXXY_VERSION}; upgrade with: npm i -g @moxxy/cli`);
  } else {
    log.info(`moxxy ${moxxyCli.version} at ${moxxyCli.path}`);
  }

  const store = new Store();
  const hub = new SpaHub(config.spaToken);
  // Wrapped so domain modules can react to run lifecycle broadcasts
  // (an implement run reaching review flips its proposal to review too).
  let proposalsRef: Proposals | null = null;
  const broadcast: typeof hub.broadcast = (msg) => {
    hub.broadcast(msg);
    if (msg.t === 'run.changed' && msg.run.status === 'review') {
      proposalsRef?.onRunReview(msg.run.id);
    }
  };

  // GitHub client (PAT lives in the settings table; recreated on change).
  let ghClient: GitHubClient | null = null;
  let ghUser: string | null = null;
  const savedToken = store.getSetting('github_token');
  if (savedToken) {
    ghClient = new GitHubClient(savedToken);
    ghClient
      .viewer()
      .then((v) => (ghUser = v.login))
      .catch((err) => log.warn('saved GitHub token failed validation', { err: String(err) }));
  }
  const github = (): GitHubClient | null => ghClient;
  const setGithubToken = async (token: string): Promise<{ login: string }> => {
    const candidate = new GitHubClient(token);
    const viewer = await candidate.viewer(); // validate before persisting
    store.setSetting('github_token', token);
    ghClient = candidate;
    ghUser = viewer.login;
    broadcast({ t: 'repos.changed' });
    return viewer;
  };

  const checkouts = new Checkouts(() => store.getSetting('github_token'));
  const orchestrator = new Orchestrator(store, config, moxxyCli?.path ?? 'moxxy', broadcast);
  orchestrator.recover();
  const sync = new GitHubSync(store, github, broadcast);
  sync.start();
  const triage = new Triage(store, orchestrator, checkouts, github, broadcast);
  const prReviews = new PrReviews(store, orchestrator, checkouts, github, broadcast);
  const fixes = new Fixes(store, orchestrator, checkouts, github, broadcast);
  const proposals = new Proposals(store, orchestrator, fixes, checkouts, broadcast);
  proposalsRef = proposals;
  const automations = new Automations(store, orchestrator, triage, prReviews, sync, checkouts, broadcast);
  automations.start();
  const skills = new Skills();

  // Serve the built SPA when present (production); dev uses Vite + proxy.
  const here = dirname(fileURLToPath(import.meta.url));
  const builtSpa = join(here, '..', '..', 'web', 'dist');
  const server = await startHttpServer({
    port: config.port,
    deps: {
      config,
      orchestrator,
      moxxyCli,
      store,
      github,
      githubUser: () => ghUser,
      setGithubToken,
      sync,
      checkouts,
      triage,
      prReviews,
      fixes,
      proposals,
      automations,
      skills,
    },
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
    sync.stop();
    automations.stop();
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
