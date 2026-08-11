#!/usr/bin/env node
/**
 * Install-flow smoke: boot the real daemon against a scratch COMPANION_HOME and
 * walk the documented first-run path over plain HTTP: healthz, the bootstrap
 * token file, first-admin setup, login, create a workspace, list it, clean
 * SIGTERM shutdown. Requires a prior `pnpm -r build`; adds no dependencies.
 *
 * The daemon helpers are exported so the browser E2E boots the same way.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Spawn the built daemon on a scratch home and port. The inherited COMPANION_*
 * variables are dropped and cwd is the scratch home, so neither the developer's
 * environment nor the repo's .env can leak accounts into the first-run flow.
 */
export async function startDaemon({ home, port, env: extraEnv } = {}) {
  const entry = join(repoRoot, 'apps', 'api', 'dist', 'index.js');
  if (!existsSync(entry)) {
    throw new Error(`daemon not built (${entry} missing): run \`pnpm -r build\` first`);
  }
  const resolvedHome = home ?? (await mkdtemp(join(tmpdir(), 'companion-smoke-')));
  const resolvedPort = port ?? (await freePort());
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COMPANION_')));
  env.COMPANION_HOME = resolvedHome;
  env.COMPANION_PORT = String(resolvedPort);
  Object.assign(env, extraEnv);

  const lines = [];
  const capture = (stream) => {
    let rest = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      rest += chunk;
      let at;
      while ((at = rest.indexOf('\n')) >= 0) {
        lines.push(rest.slice(0, at));
        rest = rest.slice(at + 1);
        if (lines.length > 500) lines.shift();
      }
    });
  };
  const proc = spawn(process.execPath, [entry], {
    cwd: resolvedHome,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  capture(proc.stdout);
  capture(proc.stderr);

  return {
    home: resolvedHome,
    port: resolvedPort,
    baseUrl: `http://127.0.0.1:${resolvedPort}`,
    proc,
    logTail: (count = 80) => lines.slice(-count).join('\n'),
    /** SIGTERM and wait for a clean exit; escalates to SIGKILL after 15s. */
    stop: async () => {
      if (proc.exitCode !== null) return proc.exitCode;
      const exited = new Promise((resolve) => proc.once('exit', (code, signal) => resolve({ code, signal })));
      proc.kill('SIGTERM');
      const outcome = await Promise.race([exited, delay(15_000).then(() => null)]);
      if (outcome === null) {
        proc.kill('SIGKILL');
        throw new Error('daemon did not exit within 15s of SIGTERM');
      }
      return outcome.code ?? outcome.signal;
    },
  };
}

export async function waitForHealthz(daemon, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (daemon.proc.exitCode !== null) {
      throw new Error(`daemon exited with code ${daemon.proc.exitCode} before /healthz came up`);
    }
    try {
      const res = await fetch(`${daemon.baseUrl}/healthz`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await delay(250);
  }
  throw new Error(`daemon did not answer /healthz within ${timeoutMs}ms`);
}

/** The one-time first-admin capability the daemon writes on a clean home. */
export async function readBootstrapToken(home, timeoutMs = 10_000) {
  const file = join(home, 'bootstrap-token');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const token = (await readFile(file, 'utf8')).trim();
      if (token.length >= 32) return token;
    } catch {
      // not written yet
    }
    await delay(100);
  }
  throw new Error(`bootstrap token file ${file} did not appear within ${timeoutMs}ms`);
}

/**
 * Minimal API client: JSON in/out, the browser CSRF proof on every mutation,
 * and the companion.session cookie captured from setup/login responses.
 */
export function apiClient(baseUrl) {
  let cookie = null;
  const request = async (method, path, body) => {
    const headers = { 'x-companion-csrf': '1' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const setCookie of res.headers.getSetCookie()) {
      if (setCookie.startsWith('companion.session=')) cookie = setCookie.split(';')[0];
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // non-JSON error body; keep the raw text for the failure message
    }
    return { status: res.status, json, text };
  };
  return {
    request,
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    clearSession: () => {
      cookie = null;
    },
  };
}

async function main() {
  const admin = { username: 'smoke-admin', email: 'smoke@example.com', password: 'CorrectHorse1!' };
  let daemon = null;
  let step = 'start daemon';
  const expect = (condition, detail) => {
    if (!condition) throw new Error(detail);
  };
  try {
    daemon = await startDaemon();
    console.log(`daemon pid ${daemon.proc.pid}, home ${daemon.home}, port ${daemon.port}`);

    step = 'wait for /healthz';
    await waitForHealthz(daemon);

    step = 'read bootstrap token';
    const bootstrapToken = await readBootstrapToken(daemon.home);

    const api = apiClient(daemon.baseUrl);

    step = 'first-admin setup';
    const setup = await api.post('/api/auth/setup', { ...admin, bootstrapToken });
    expect(setup.status === 200, `setup answered ${setup.status}: ${setup.text}`);
    expect(setup.json?.user?.role === 'admin', `setup did not create an admin: ${setup.text}`);
    await delay(100);
    expect(!existsSync(join(daemon.home, 'bootstrap-token')), 'bootstrap token file survived setup');

    step = 'login';
    api.clearSession();
    const login = await api.post('/api/auth/login', { username: admin.username, password: admin.password });
    expect(login.status === 200, `login answered ${login.status}: ${login.text}`);
    expect(login.json?.user?.username === admin.username, `login returned the wrong user: ${login.text}`);

    step = 'create workspace';
    const createdWorkspace = await api.post('/api/workspaces', { name: 'Smoke Test' });
    expect(createdWorkspace.status === 201, `workspace create answered ${createdWorkspace.status}: ${createdWorkspace.text}`);
    const workspaceId = createdWorkspace.json?.workspace?.id;
    expect(typeof workspaceId === 'string', `workspace create returned no id: ${createdWorkspace.text}`);

    step = 'list workspaces';
    const listing = await api.get('/api/workspaces');
    expect(listing.status === 200, `workspace list answered ${listing.status}: ${listing.text}`);
    const names = (listing.json?.workspaces ?? []).map((w) => `${w.id}:${w.name}`);
    expect(
      listing.json?.workspaces?.some((w) => w.id === workspaceId && w.name === 'Smoke Test'),
      `created workspace missing from listing: [${names.join(', ')}]`,
    );

    step = 'shutdown';
    const exit = await daemon.stop();
    expect(exit === 0, `daemon exited with ${exit} after SIGTERM`);

    // Best effort: a straggler write under moxxy-home must not fail the smoke.
    await rm(daemon.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    console.log(`smoke-install OK: setup -> login -> workspace ${workspaceId} created and listed -> clean shutdown`);
  } catch (err) {
    console.error(`smoke-install FAILED at step "${step}": ${err instanceof Error ? err.message : err}`);
    if (daemon) {
      console.error('--- daemon log tail ---');
      console.error(daemon.logTail());
      daemon.proc.kill('SIGKILL');
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
