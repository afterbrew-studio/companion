// MUST stay the first import: pins COMPANION_HOME to the runner's own home
// before any reused companiond module can resolve a path through config.ts.
import './bootstrap.js';

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { paths } from '@moxxy/companion-services';
import { Checkouts } from '@companion/module-operate/exec';
import { detectMoxxyCli, MIN_MOXXY_VERSION } from '@companion/module-operate/exec';
import { GatewayPool } from '@companion/module-operate/exec';
import {
  healCredentialLinks,
  homeStatus,
  importProvidersFromDailyMoxxy,
  seedPermissionDenyRules,
} from '@companion/module-operate/exec';
import { autostart } from './autostart.js';
import { removePidFile, startBackground, statusBackground, stopBackground, writePidFile } from './background.js';
import { loadRunnerConfig } from './config.js';
import { log } from './log.js';
import { runDoctor } from './doctor.js';
import { openFirewall } from './firewall.js';
import { EventHub, startAgentServer } from './server.js';

const HELP = `companion-runner — run Companion agent work on this machine

Usage:
  companion-runner                 Start the runner agent in the foreground.
  companion-runner --background    Start it detached; logs go to <home>/runner.log.
  companion-runner status          Show whether a runner is running (and its pid).
  companion-runner stop            Stop a running runner.
  companion-runner doctor          Check this machine is ready to attach.
  companion-runner setup           Check + install/repair prerequisites (moxxy CLI,
                                   providers, host firewall).
  companion-runner open-firewall   Open the agent port on this machine's firewall.
  companion-runner autostart       Start on boot & restart on crash (launchd/systemd).
  companion-runner autostart off   Remove the boot registration.
  companion-runner --help          Show this help.

Key environment (see the README for the full list):
  COMPANION_RUNNER_TOKEN          Bearer token Companion presents (generated if unset).
  COMPANION_RUNNER_PORT           Bind port (default 8920).
  COMPANION_RUNNER_HOME           Data root (default ~/.companion-runner).
  COMPANION_RUNNER_GITHUB_TOKEN   Optional machine-specific GitHub PAT. Normally
                                  unset: Companion sends its own configured
                                  credential with each git operation.
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv.find((a) => !a.startsWith('-'));
  if (argv.includes('--help') || argv.includes('-h') || cmd === 'help') {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === 'doctor' || cmd === 'setup') {
    process.exit(await runDoctor({ fix: cmd === 'setup' || argv.includes('--fix') }));
  }
  if (cmd === 'status') {
    statusBackground();
    return;
  }
  if (cmd === 'stop') {
    process.exit(await stopBackground());
  }
  if (cmd === 'open-firewall') {
    process.exit(await openFirewall(loadRunnerConfig().port));
  }
  if (cmd === 'autostart') {
    const sub = argv.filter((a) => !a.startsWith('-'))[1];
    process.exit(await autostart(sub === 'off' ? 'off' : sub === 'status' ? 'status' : 'install'));
  }
  if (cmd !== undefined) {
    process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
    process.exit(2);
  }
  if (argv.includes('--background') || argv.includes('-b')) {
    startBackground();
    return;
  }

  const config = loadRunnerConfig();
  writePidFile();
  log.info(`data root: ${config.home}`);

  // Same moxxy-home bootstrap companiond does: deny rules fence unattended
  // runs (agents never push — the controlling companiond pushes after review),
  // and provider credentials ride the daily ~/.moxxy. The runner is headless,
  // so the first boot imports them automatically when a daily home exists.
  seedPermissionDenyRules();
  if (!homeStatus().providersImported && existsSync(join(homedir(), '.moxxy'))) {
    log.info('first boot: importing moxxy provider credentials from ~/.moxxy');
    importProvidersFromDailyMoxxy();
  }
  healCredentialLinks();

  const moxxy = await detectMoxxyCli(paths.moxxyHome());
  if (!moxxy) {
    log.warn(
      `moxxy CLI not found on PATH — run "companion-runner setup" to install it (npm i -g @moxxy/cli, >= ${MIN_MOXXY_VERSION}). ` +
        'The runner starts anyway; spawns will fail until moxxy is installed.',
    );
  } else if (!moxxy.compatible) {
    log.warn(`installed moxxy ${moxxy.version} is older than ${MIN_MOXXY_VERSION}; upgrade with: npm i -g @moxxy/cli`);
  } else {
    log.info(`moxxy ${moxxy.version} at ${moxxy.path}`);
  }

  if (config.githubToken) {
    log.info('COMPANION_RUNNER_GITHUB_TOKEN set — this machine uses its own GitHub credential');
  } else {
    log.info('no machine GitHub token — Companion supplies its credential with each git operation');
  }
  const checkouts = new Checkouts(() => config.githubToken);

  // Every pool callback fans out to the connected companiond(s) as the
  // matching AgentEventMessage — the remote twin of a local gateway's sink.
  const hub = new EventHub();
  const pool = new GatewayPool(
    {
      onEvent: (runId, event) => hub.broadcast({ t: 'event', runId, event }),
      onTurnComplete: (runId, turnId) => hub.broadcast({ t: 'turn.complete', runId, turnId }),
      onAsk: (runId, ask) => hub.broadcast({ t: 'ask', runId, ask }),
      onAskResolved: (runId, requestId) => hub.broadcast({ t: 'ask.resolved', runId, requestId }),
      onGone: (runId) => hub.broadcast({ t: 'gone', runId }),
    },
    config.maxRuns,
  );

  const server = await startAgentServer({
    host: config.host,
    port: config.port,
    token: config.token,
    deps: { pool, checkouts, moxxy, maxRuns: config.maxRuns },
    hub,
  });

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down…');
    const force = setTimeout(() => process.exit(0), 6_000);
    force.unref();
    await pool.stopAll();
    hub.close();
    server.close();
    removePidFile();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  log.error('fatal boot error', err);
  process.exit(1);
});
