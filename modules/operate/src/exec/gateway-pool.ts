import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import type { AskRequest, MoxxyEvent } from '@moxxy/companion-types';
import { log, paths } from '@moxxy/companion-services';
import { GatewayClient } from './gateway-client.js';
import { providerDefaultsFromConfigYaml, readHomeFile, type ProviderDefaults } from './home.js';

/**
 * One live agent run = TWO moxxy processes under Companion's isolated
 * MOXXY_HOME (the desktop supervisor's proven topology):
 *
 *   1. `moxxy serve` — owns the session. The ONLY entry point that honors
 *      MOXXY_SESSION_ID (sticky resume), so the session persists under the
 *      run id and survives daemon restarts. Binds the per-run runner socket.
 *   2. `moxxy mobile` — attaches to that socket as a thin client (a runner is
 *      up → attach mode, no second session) and serves the WS gateway
 *      companiond drives.
 *
 * Spawn invariants (learned the hard way):
 *  - MOXXY_HOME must ALWAYS be set — a bare `moxxy` invocation touches ~/.moxxy.
 *  - A standalone channel boot IGNORES MOXXY_SESSION_ID (fresh ULID session);
 *    hence serve+attach, never `moxxy mobile --standalone`.
 *  - The gateway port must travel via `--config <yaml>` (a real YAML number):
 *    CLI flags arrive as strings and the channel's option sanitizer drops them.
 *  - `--no-expo`: the mobile channel launches an Expo dev server by default.
 *  - `--tunnel localhost`: never open the proxy relay for a local-only gateway.
 *  - MOXXY_NO_WEB_SURFACE=1: channels/serve co-attach a web surface on a fixed
 *    port (4040) by default; concurrent runs would collide.
 *  - MOXXY_MOBILE_QUERY_TOKEN=0: close the legacy `?t=` token path.
 */

export interface GatewayHandle {
  readonly runId: string;
  readonly port: number;
  readonly client: GatewayClient;
  stop(): Promise<void>;
}

export interface GatewayCallbacks {
  onEvent(runId: string, event: MoxxyEvent): void;
  onTurnComplete(runId: string, turnId?: string): void;
  onAsk(runId: string, ask: AskRequest): void;
  onAskResolved(runId: string, requestId: string): void;
  /** Gateway died (process exit or socket loss) — the run is no longer live. */
  onGone(runId: string): void;
}

export interface SpawnOptions {
  readonly runId: string;
  readonly cwd: string;
  readonly moxxyCliPath: string;
}

const SERVE_READY_TIMEOUT_MS = 120_000;
const GATEWAY_READY_TIMEOUT_MS = 60_000;
const STOP_GRACE_MS = 5_000;

/** Build the isolated per-run overlay without mutating the imported moxxy config. */
export function gatewayConfigYaml(port: number, skillsDir: string, provider: ProviderDefaults | null): string {
  const providerYaml = provider
    ? `provider:\n  name: ${JSON.stringify(provider.name)}\n${provider.model ? `  model: ${JSON.stringify(provider.model)}\n` : ''}`
    : '';
  return `${providerYaml}channels:\n  mobile:\n    port: ${port}\nskills:\n  userDir: ${JSON.stringify(skillsDir)}\n`;
}

interface Child {
  readonly proc: ChildProcess;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stderrTail(): string;
}

export class GatewayPool {
  private readonly live = new Map<string, GatewayHandle>();

  constructor(
    private readonly callbacks: GatewayCallbacks,
    private readonly maxLive: number,
  ) {}

  get liveCount(): number {
    return this.live.size;
  }

  get(runId: string): GatewayHandle | undefined {
    return this.live.get(runId);
  }

  /** Run ids with an attached gateway right now. */
  liveIds(): string[] {
    return [...this.live.keys()];
  }

  list(): string[] {
    return [...this.live.keys()];
  }

  async spawn(opts: SpawnOptions): Promise<GatewayHandle> {
    const existing = this.live.get(opts.runId);
    if (existing) return existing;
    if (this.live.size >= this.maxLive) {
      throw new Error(`gateway pool is full (${this.maxLive} live runs); stop one first`);
    }

    const port = await freePort();
    const token = randomBytes(32).toString('hex');
    const socketPath = join(paths.sockets(), `run-${opts.runId}.sock`);
    // skills.userDir: moxxy's defaultUserSkillsDir() hardcodes ~/.moxxy/skills
    // (ignores MOXXY_HOME — upstream bug), so point it at Companion's skills.
    const configFile = join(paths.runConfigs(), `${opts.runId}.yaml`);
    const provider = providerDefaultsFromConfigYaml(readHomeFile('config.yaml'));
    writeFileSync(
      configFile,
      gatewayConfigYaml(port, join(paths.moxxyHome(), 'skills'), provider),
    );

    const baseEnv = {
      ...process.env,
      MOXXY_HOME: paths.moxxyHome(),
      MOXXY_RUNNER_SOCKET: socketPath,
      MOXXY_NO_WEB_SURFACE: '1',
      MOXXY_NO_CORE_UPDATE: '1',
    };

    // 1. The session owner. Sticky MOXXY_SESSION_ID → the session file on disk
    // is named after the run id, giving resume + direct JSONL history reads.
    const serve = watchChild(
      spawn(opts.moxxyCliPath, ['serve', '--config', configFile], {
        cwd: opts.cwd,
        env: { ...baseEnv, MOXXY_SESSION_ID: opts.runId, MOXXY_SESSION_SOURCE: 'mobile' },
        stdio: ['ignore', 'ignore', 'pipe'],
      }),
    );

    try {
      await waitForUnixSocket(socketPath, serve, SERVE_READY_TIMEOUT_MS);
    } catch (err) {
      serve.proc.kill('SIGKILL');
      throw err;
    }

    // 2. The gateway thin client. Runner is up on the per-run socket → attach
    // mode (no second session).
    const mobile = watchChild(
      spawn(
        opts.moxxyCliPath,
        ['mobile', '--no-expo', '--tunnel', 'localhost', '--config', configFile],
        {
          cwd: opts.cwd,
          env: {
            ...baseEnv,
            MOXXY_MOBILE_TOKEN: token,
            MOXXY_MOBILE_HOST: '127.0.0.1',
            MOXXY_MOBILE_QUERY_TOKEN: '0',
          },
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      ),
    );

    const client = new GatewayClient(`ws://127.0.0.1:${port}/`, token, {
      onEvent: (event) => this.callbacks.onEvent(opts.runId, event),
      onTurnComplete: (p) => this.callbacks.onTurnComplete(opts.runId, p.turnId),
      onAsk: (ask) => this.callbacks.onAsk(opts.runId, ask),
      onAskResolved: (p) => this.callbacks.onAskResolved(opts.runId, p.requestId),
      onClose: () => this.drop(opts.runId),
    });

    try {
      await waitForGateway(client, mobile, GATEWAY_READY_TIMEOUT_MS);
    } catch (err) {
      mobile.proc.kill('SIGKILL');
      serve.proc.kill('SIGKILL');
      throw err;
    }

    const stopChild = async (child: Child): Promise<void> => {
      if (child.proc.exitCode === null && !child.proc.killed) {
        child.proc.kill('SIGTERM');
        const timer = setTimeout(() => child.proc.kill('SIGKILL'), STOP_GRACE_MS);
        await child.exited;
        clearTimeout(timer);
      }
    };

    // A stop tears both children down and only then drops the run, so without
    // this the exit handlers below fire while the run is still live and report
    // every deliberate shutdown as a failure.
    let stopping = false;

    const handle: GatewayHandle = {
      runId: opts.runId,
      port,
      client,
      stop: async () => {
        stopping = true;
        client.close();
        await stopChild(mobile);
        await stopChild(serve);
        this.drop(opts.runId);
      },
    };

    // Either process dying makes the run non-live; tear the sibling down too.
    for (const child of [serve, mobile]) {
      void child.exited.then(({ code, signal }) => {
        if (stopping) {
          log.debug('gateway process exited on request', { runId: opts.runId, code, signal });
          return;
        }
        if (!this.live.has(opts.runId)) return;
        // Nobody asked for this. A clean exit still ends the run, but only a
        // crash is something the operator has to do anything about.
        const meta = { runId: opts.runId, code, signal };
        if (code === 0 && signal === null) log.info('gateway process exited on its own', meta);
        else log.warn('gateway process exited', meta);
        void stopChild(child === serve ? mobile : serve);
        this.drop(opts.runId);
      });
    }

    this.live.set(opts.runId, handle);
    log.info('gateway ready', {
      runId: opts.runId,
      port,
      servePid: serve.proc.pid,
      mobilePid: mobile.proc.pid,
    });
    return handle;
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.live.values()].map((h) => h.stop()));
  }

  private drop(runId: string): void {
    const handle = this.live.get(runId);
    if (!handle) return;
    this.live.delete(runId);
    handle.client.close();
    this.callbacks.onGone(runId);
  }
}

function watchChild(proc: ChildProcess): Child {
  let tail = '';
  proc.stdout?.on('data', () => undefined); // drain banner/QR noise
  proc.stderr?.on('data', (chunk: Buffer) => {
    tail = (tail + chunk.toString()).slice(-4000);
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    proc.once('exit', (code, signal) => resolve({ code, signal })),
  );
  return { proc, exited, stderrTail: () => tail };
}

/** Wait until the runner's unix socket accepts a connection. */
async function waitForUnixSocket(socketPath: string, child: Child, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let dead = false;
  void child.exited.then(() => (dead = true));
  while (Date.now() < deadline) {
    if (dead) {
      throw new Error(
        `moxxy serve exited during boot (code=${child.proc.exitCode}): ${child.stderrTail().slice(-500)}`,
      );
    }
    const ok = await new Promise<boolean>((resolve) => {
      const sock = connect(socketPath);
      const done = (value: boolean): void => {
        sock.destroy();
        resolve(value);
      };
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
      setTimeout(() => done(false), 1_000);
    });
    if (ok) return;
    await sleep(400);
  }
  throw new Error(`moxxy serve socket not ready after ${timeoutMs}ms (${socketPath})`);
}

/** Poll a WS connect + session.info until the gateway accepts us. */
async function waitForGateway(client: GatewayClient, child: Child, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  let dead = false;
  void child.exited.then(() => (dead = true));
  while (Date.now() < deadline) {
    if (dead) {
      throw new Error(
        `moxxy gateway exited during boot (code=${child.proc.exitCode}): ${child.stderrTail().slice(-500)}`,
      );
    }
    try {
      await client.connect(3_000);
      await client.sessionInfo();
      return;
    } catch (err) {
      lastErr = err;
      await sleep(500);
    }
  }
  throw new Error(`moxxy gateway not ready after ${timeoutMs}ms: ${String(lastErr)}`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('failed to allocate a port')));
      }
    });
    srv.on('error', reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
