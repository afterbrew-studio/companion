#!/usr/bin/env node
/**
 * Capture the README screenshots off a running demo instance.
 *
 *   COMPANION_HOME=/tmp/companion-demo/.companion node apps/api/dist/index.js
 *   node scripts/demo-seed.mjs  --home /tmp/companion-demo/.companion
 *   node scripts/demo-shots.mjs --url http://127.0.0.1:8901
 *
 * Drives headless Chrome over CDP rather than a real window, so a shot is the
 * same size and pixel density on any machine: 1440x900 at 2x, which is what
 * makes the text in docs/media/*.png readable when GitHub scales it down.
 *
 * Point it only at the demo instance. It signs in as its admin, and the
 * credential below is the one a local first run offers.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const OUT = 'docs/media';
const LOGIN = { username: 'admin', password: 'admin1234' };
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 2 };
/** Every step key the modules declare: marking them seen keeps the first-run tour off the shots. */
const ONBOARDING_STEPS = ['welcome', 'connect', 'code', 'workspaces', 'runners', 'assistant', 'ideas', 'plan'];

/**
 * Each shot: the hash route, the file, and what proves the page has rendered.
 * These are the ones the README embeds; any other route works the same way.
 */
const SHOTS = [
  { name: 'overview', hash: '#/overview', awaits: 'Acme' },
  { name: 'run', hash: '#/runs/run-demo-fix-412', awaits: 'settlement' },
  { name: 'modules', hash: '#/modules', awaits: 'workspace' },
];

const base = readArg('--url') ?? 'http://127.0.0.1:8901';
const theme = readArg('--theme') ?? 'dark';

const token = await login();
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--hide-scrollbars',
    // Dates and numbers in the shots follow the page's locale, not the
    // operator's: a README in English must not show Polish month names.
    '--lang=en-US',
    '--no-first-run',
    '--disable-extensions',
    `--user-data-dir=/tmp/companion-demo/chrome-profile`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

try {
  const cdp = await connect();
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, mobile: false });
  await cdp.send('Emulation.setLocaleOverride', { locale: 'en-US' }).catch(() => undefined);

  // The session and the theme are page state, so they have to be planted on the
  // origin before the SPA boots: index.html reads the theme before first paint.
  await goto(cdp, base);
  await evaluate(cdp, `localStorage.setItem('companion.session', ${JSON.stringify(token)});
    localStorage.setItem('companion.theme', ${JSON.stringify(theme)});
    localStorage.setItem('companion.sidebar', 'expanded');
    localStorage.setItem('companion.onboarding.seen', ${JSON.stringify(JSON.stringify(ONBOARDING_STEPS))});`);

  mkdirSync(OUT, { recursive: true });
  for (const shot of SHOTS) {
    await goto(cdp, `${base}/${shot.hash}`, true);
    await settle(cdp, shot.awaits);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = join(OUT, `${shot.name}${theme === 'light' ? '-light' : ''}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`${file}`);
  }
  cdp.close();
} finally {
  chrome.kill();
}

async function login() {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(LOGIN),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const { token } = await res.json();
  return token;
}

/** Chrome needs a moment to open the debugging port on a cold start. */
async function connect() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = targets.find((t) => t.type === 'page');
      if (page) return await open(page.webSocketDebuggerUrl);
    } catch {
      // not listening yet
    }
    await sleep(250);
  }
  throw new Error('Chrome did not expose a debugging target.');
}

function open(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let id = 0;
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
    };
    socket.onerror = () => reject(new Error('CDP socket failed'));
    socket.onopen = () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            id += 1;
            pending.set(id, { resolve: res, reject: rej });
            socket.send(JSON.stringify({ id, method, params }));
          }),
        close: () => socket.close(),
      });
  });
}

/**
 * Navigate and boot the SPA fresh. A hash-only change is an in-page
 * navigation, so without the reload the app that already mounted on the login
 * screen never re-reads the session that was planted after it.
 */
async function goto(cdp, url, reload = false) {
  await cdp.send('Page.navigate', { url });
  await sleep(400);
  if (reload) await cdp.send('Page.reload', {});
  await sleep(600);
}

/**
 * Wait for the page's own text rather than a fixed delay: these views paint
 * their frame first and fill it from the API, so a timer races the data.
 */
async function settle(cdp, needle) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const found = await evaluate(cdp, `document.body.innerText.toLowerCase().includes(${JSON.stringify(needle.toLowerCase())})`);
    if (found?.result?.value === true) {
      await sleep(500);
      return;
    }
    await sleep(250);
  }
  console.warn(`  (never saw "${needle}", capturing anyway)`);
}

function evaluate(cdp, expression) {
  return cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
}

function readArg(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}
