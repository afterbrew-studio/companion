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

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const OUT = 'docs/media';
/** Tour frames are intermediates: they become tour.gif, so they stay out of the repo. */
const TEMP = mkdtempSync(join(tmpdir(), 'companion-demo-shots-'));
const FRAMES = join(TEMP, 'frames');
const LOGIN = { username: 'admin', password: 'admin1234' };
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 2 };
/** Every step key the modules declare: marking them seen keeps the first-run tour off the shots. */
const ONBOARDING_STEPS = ['welcome', 'connect', 'code', 'workspaces', 'runners', 'assistant', 'ideas', 'plan'];

process.once('exit', () => rmSync(TEMP, { recursive: true, force: true }));

/**
 * Each shot: the hash route, the file, and what proves the page has rendered.
 * `tour` marks the frames that become docs/media/tour.gif; the two that do not
 * are embedded as stills, where a reader needs to stop and read them.
 */
const SHOTS = [
  { name: 'overview', hash: '#/overview', awaits: 'Acme' },
  { name: 'issues', hash: '#/issues', awaits: 'refunds above', tour: true },
  { name: 'issue', hash: '#/repos/acme/payments-api/issues/412', awaits: 'threshold problem', tour: true },
  { name: 'prs', hash: '#/prs', awaits: 'settlement currency', tour: true },
  { name: 'pr', hash: '#/repos/acme/payments-api/prs/418', awaits: 'Changed files', tour: true, expand: 'Changed files' },
  { name: 'pr-review', hash: '#/repos/acme/payments-api/prs/417/review', awaits: 'reconcil', tour: true },
  { name: 'pipelines', hash: '#/pipelines', awaits: 'PR gate', tour: true },
  { name: 'runs', hash: '#/runs', awaits: 'Triage', tour: true },
  { name: 'run', hash: '#/runs/run-demo-fix-412', awaits: 'settlement', tour: true },
  { name: 'modules', hash: '#/modules', awaits: 'workspace', tour: true },
];

/** Seconds each tour frame holds. Long enough to read a heading and a row or two. */
const FRAME_SECONDS = 2.6;
const TOUR_WIDTH = 1100;

const base = readArg('--url') ?? 'http://127.0.0.1:8901';
const theme = readArg('--theme') ?? 'dark';

const sessionCookie = await login();
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
    `--user-data-dir=${join(TEMP, 'chrome-profile')}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

try {
  const cdp = await connect();
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, mobile: false });
  await cdp.send('Emulation.setLocaleOverride', { locale: 'en-US' }).catch(() => undefined);

  // Authentication deliberately stays in an HttpOnly cookie. Plant it through
  // CDP's cookie API (never localStorage), before the SPA makes its first /me.
  await cdp.send('Network.setCookie', {
    name: sessionCookie.name,
    value: sessionCookie.value,
    url: base,
    httpOnly: true,
    sameSite: 'Strict',
  });
  // Theme/sidebar preferences are non-sensitive page state. Plant them on the
  // origin before the SPA boots: index.html reads the theme before first paint.
  await goto(cdp, base);
  await evaluate(cdp, `localStorage.setItem('companion.theme', ${JSON.stringify(theme)});
    localStorage.setItem('companion.sidebar', 'expanded');
    localStorage.setItem('companion.onboarding.seen', ${JSON.stringify(JSON.stringify(ONBOARDING_STEPS))});`);

  mkdirSync(OUT, { recursive: true });
  mkdirSync(FRAMES, { recursive: true });
  for (const shot of SHOTS) {
    await goto(cdp, `${base}/${shot.hash}`, true);
    await settle(cdp, shot.awaits);
    if (shot.expand) await expand(cdp, shot.expand);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = join(shot.tour ? FRAMES : OUT, `${shot.name}${theme === 'light' ? '-light' : ''}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`${file}`);
  }
  cdp.close();
} finally {
  chrome.kill();
}

if (theme !== 'light') buildTour();

/**
 * Assemble the tour frames into one GIF. A shared palette across all frames
 * (rather than one per frame) is what keeps a UI this flat from banding, and
 * keeps the file small enough to sit in a README.
 */
function buildTour() {
  const frames = SHOTS.filter((shot) => shot.tour).map((shot) => join(FRAMES, `${shot.name}.png`));
  const list = join(FRAMES, 'frames.txt');
  // concat demuxer: every frame holds FRAME_SECONDS, and the last one is
  // repeated because its duration is otherwise ignored.
  writeFileSync(
    list,
    [...frames, frames[frames.length - 1]]
      .map((frame) => `file '${basename(frame)}'\nduration ${FRAME_SECONDS}`)
      .join('\n') + '\n',
  );

  const filters = `scale=${TOUR_WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192[p];[b][p]paletteuse=dither=bayer:bayer_scale=3`;
  const out = join(OUT, 'tour.gif');
  execFileSync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-filter_complex', filters, '-loop', '0', out], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  rmSync(list, { force: true });
  console.log(`${out}`);
}

async function login() {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-companion-csrf': '1',
    },
    body: JSON.stringify(LOGIN),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const raw = res.headers.get('set-cookie');
  const pair = raw?.split(';', 1)[0];
  const at = pair?.indexOf('=') ?? -1;
  if (!pair || at <= 0) throw new Error('login response did not set a browser session cookie');
  return { name: pair.slice(0, at), value: decodeURIComponent(pair.slice(at + 1)) };
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

/** Open a collapsed section by its heading, so the shot shows its contents. */
async function expand(cdp, label) {
  await evaluate(
    cdp,
    `(() => {
      const label = ${JSON.stringify(label)};
      const node = [...document.querySelectorAll('button, summary, [role="button"]')]
        .find((el) => el.textContent?.trim().startsWith(label));
      if (!node) return false;
      node.click();
      return true;
    })()`,
  );
  await sleep(900);
}

function evaluate(cdp, expression) {
  return cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
}

function readArg(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}
