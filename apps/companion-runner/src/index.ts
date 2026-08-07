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
import { CliHarnessSessions } from './harnesses.js';
import { runTokenCommand } from './token-cli.js';
import { RunnerTokens } from './tokens.js';
import { RunnerTunnel } from './tunnel.js';
import { Dashboard } from './tui.js';
import { removePidFile, startBackground, statusBackground, stopBackground, writePidFile } from './background.js';
import { loadRunnerConfig } from './config.js';
import { RuntimeSessions } from './runtime-sessions.js';
import { log, setLogSink } from './log.js';
import { runDoctor } from './doctor.js';
import { openFirewall } from './firewall.js';
import { EventHub, startAgentServer } from './server.js';

const HELP = `companion-runner — run Companion agent work on this machine

Usage:
  companion-runner                 Start the runner agent in the foreground.
  companion-runner ui              Start it with a live dashboard instead of logs.
  companion-runner --background    Start it detached; logs go to <home>/runner.log.
  companion-runner --tunnel        Also publish this machine at a public https URL.
  companion-runner status          Show whether a runner is running (and its pid).
  companion-runner stop            Stop a running runner.
  companion-runner doctor          Check this machine is ready to attach.
  companion-runner setup           Check + install/repair prerequisites (moxxy CLI,
                                   providers, host firewall).
  companion-runner token           Issue, list and revoke Companion's credentials.
  companion-runner open-firewall   Open the agent port on this machine's firewall.
  companion-runner autostart       Start on boot & restart on crash (launchd/systemd).
  companion-runner autostart off   Remove the boot registration.
  companion-runner --help          Show this help.

Key environment (see the README for the full list):
  COMPANION_RUNNER_TOKEN          Bearer token Companion presents. Optional: without
                                  it the runner issues one into its own token store,
                                  which "companion-runner token" rotates live.
  COMPANION_RUNNER_PORT           Bind port (default 8920).
  COMPANION_RUNNER_HOME           Data root (default ~/.companion-runner).
  COMPANION_RUNNER_TUNNEL         Set to 1 to publish a public https address at start.
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
  if (cmd === 'token') {
    process.exit(runTokenCommand(argv.filter((a) => !a.startsWith('-')).slice(1)));
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
  if (cmd !== undefined && cmd !== 'ui') {
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

  // Credentials live in a store this process re-reads whenever it changes, so
  // rotating one is a CLI call rather than a restart of a machine that may be
  // running somebody's work. A machine nobody can authenticate to is useless,
  // so a first boot with none issues one and prints it.
  const tokens = new RunnerTokens(config.home, config.tokenEnv);
  if (!tokens.usable) {
    const { token, secret } = tokens.issue('first boot');
    log.info(`issued the first runner token ${token.id}: ${secret}`);
    log.info('register this machine in Companion with that token; rotate it with "companion-runner token"');
  }

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

  // Agent CLIs installed on THIS machine. A developer laptop is attached
  // precisely because it holds those sign-ins, so a run placed here can use
  // them; a bare container simply reports none and runs nothing through them.
  const cli = new CliHarnessSessions(
    (runId, event) => hub.broadcast({ t: 'event', runId, event }),
    (runId, turnId) => hub.broadcast({ t: 'turn.complete', runId, turnId }),
    (runId) => hub.broadcast({ t: 'gone', runId }),
  );
  for (const runtimeHealth of await cli.runtimes()) {
    log.info(
      `runtime ${runtimeHealth.id}${runtimeHealth.version ? ` ${runtimeHealth.version}` : ''}: ${runtimeHealth.state}`,
      runtimeHealth.detail ? { detail: runtimeHealth.detail } : undefined,
    );
  }

  // The built-in runtime: a subprocess of this bundle rather than software
  // installed on the box, which is what lets a runner be a plain container.
  const runtime = new RuntimeSessions(
    config,
    (runId, event) => hub.broadcast({ t: 'event', runId, event }),
    (runId, turnId) => hub.broadcast({ t: 'turn.complete', runId, turnId }),
    (runId) => hub.broadcast({ t: 'gone', runId }),
    (runId, ask) => hub.broadcast({ t: 'ask', runId, ask: ask as never }),
    (runId, requestId) => hub.broadcast({ t: 'ask.resolved', runId, requestId }),
  );

  const server = await startAgentServer({
    host: config.host,
    port: config.port,
    tokens,
    deps: {
      pool,
      checkouts,
      moxxy,
      maxRuns: config.maxRuns,
      maxTools: config.maxTools,
      toolNice: config.toolNice,
      runtime,
      cli,
    },
    hub,
  });

  // A laptop is behind NAT on a network nobody will port-forward, so the relay
  // is what makes it reachable at all, and it makes the endpoint https, which
  // is the condition under which Companion may send this machine a model
  // credential or a tool's environment.
  const wantsTunnel = argv.includes('--tunnel') || process.env.COMPANION_RUNNER_TUNNEL === '1';
  const tunnel = new RunnerTunnel(config.port);
  if (wantsTunnel) {
    await tunnel.start().catch((err) => log.warn('could not open a public address', { err: String(err) }));
  }

  // The dashboard takes the screen, so the logger is redirected into its panel
  // for as long as it is up; without it the two would draw over each other.
  const dashboard =
    cmd === 'ui' && process.stdout.isTTY
      ? new Dashboard({
          config,
          tokens,
          cli,
          tunnel,
          liveRuns: () => pool.liveCount + runtime.liveCount + cli.liveCount,
          startTunnel: () => tunnel.start(),
        })
      : null;
  const closeDashboard = dashboard?.start();
  if (dashboard) setLogSink((line) => dashboard.push(line));

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    setLogSink(null);
    closeDashboard?.();
    log.info('shutting down…');
    const force = setTimeout(() => process.exit(0), 6_000);
    force.unref();
    await pool.stopAll();
    await runtime.stopAll();
    await cli.stopAll();
    await tunnel.stop().catch(() => undefined);
    tokens.close();
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
