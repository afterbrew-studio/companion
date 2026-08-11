import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { startDaemon, waitForHealthz, readBootstrapToken } from '../scripts/smoke-install.mjs';

/**
 * Browser smoke of the SPA shell over the real daemon: the built apps/web/dist
 * is served by apps/api itself (its production static path), so this drives the
 * same stack an install runs. Covers first-boot setup, the sidebar, three core
 * routes plus Settings, and the live WebSocket.
 */

interface Daemon {
  readonly home: string;
  readonly port: number;
  readonly baseUrl: string;
  readonly proc: { exitCode: number | null; kill(signal?: NodeJS.Signals): void };
  logTail(count?: number): string;
  stop(): Promise<number | string>;
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
let daemon: Daemon;

test.beforeAll(async () => {
  if (!existsSync(join(repoRoot, 'apps', 'web', 'dist', 'index.html'))) {
    throw new Error('apps/web/dist missing: run `pnpm -r build` first');
  }
  daemon = (await startDaemon()) as Daemon;
  await waitForHealthz(daemon);
});

test.afterAll(async () => {
  if (daemon) {
    const exit = await daemon.stop();
    expect(exit, 'daemon should exit cleanly on SIGTERM').toBe(0);
  }
});

async function expectHealthyPage(page: Page, crumb: string): Promise<void> {
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(crumb);
  await expect(page.getByText('Something went wrong in')).toHaveCount(0);
  await expect(page.getByText('Companion hit an unexpected error')).toHaveCount(0);
  await expect(page.getByText("This page doesn't exist")).toHaveCount(0);
}

test('first run: setup, shell, core routes, live socket', async ({ page }) => {
  // The tour would overlay the shell right after the first login.
  await page.addInitScript(() => localStorage.setItem('companion.onboarding.seen', '[]'));

  const errors: string[] = [];
  let shellUp = false;
  // Pre-auth 401s are part of the login flow; record only once the shell is up.
  page.on('console', (msg) => {
    if (msg.type() === 'error' && shellUp) errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));

  // Frames must be recorded from socket creation: the server hello lands right
  // after the upgrade, before any later listener could attach.
  const wsFrames: string[] = [];
  let wsClosed = false;
  page.on('websocket', (ws) => {
    if (!ws.url().includes('/ws')) return;
    ws.on('framereceived', (frame) => wsFrames.push(String(frame.payload)));
    ws.on('close', () => {
      wsClosed = true;
    });
  });

  await page.goto(`${daemon.baseUrl}/`);

  // First-boot onboarding with the token the daemon wrote.
  const token = (await readBootstrapToken(daemon.home)) as string;
  await expect(page.getByRole('heading', { name: 'Welcome to Companion' })).toBeVisible();
  await page.getByLabel('Admin username').fill('e2e-admin');
  await page.getByLabel('Email').fill('e2e@example.com');
  await page.getByLabel('Password (min 8 characters)').fill('CorrectHorse1!');
  await page.getByLabel('Confirm password').fill('CorrectHorse1!');
  await page.getByLabel('Bootstrap token').fill(token);
  await page.getByRole('button', { name: 'Create admin & enter' }).click();

  // The shell renders with a populated sidebar.
  const sidebar = page.getByRole('navigation', { name: 'Primary navigation' });
  await expect(sidebar).toBeVisible();
  await expect(sidebar.getByRole('link', { name: 'Overview' })).toBeVisible();
  await expect(sidebar.getByRole('link', { name: 'Issues' })).toBeVisible();
  await expect(sidebar.getByRole('link', { name: 'Repositories' })).toBeVisible();
  expect(await sidebar.getByRole('link').count()).toBeGreaterThanOrEqual(3);
  shellUp = true;

  // The live socket connects (server hello) and no reconnect banner shows.
  await expect.poll(() => wsFrames.some((frame) => frame.includes('"t":"hello"'))).toBe(true);
  expect(wsClosed).toBe(false);
  await expect(page.getByText('Connection lost, reconnecting…')).toHaveCount(0);

  await sidebar.getByRole('link', { name: 'Overview' }).click();
  await expectHealthyPage(page, 'Overview');

  await sidebar.getByRole('link', { name: 'Issues' }).click();
  await expectHealthyPage(page, 'Issues');

  await sidebar.getByRole('link', { name: 'Repositories' }).click();
  await expectHealthyPage(page, 'Repositories');

  await page.getByRole('link', { name: 'Settings' }).click();
  await expectHealthyPage(page, 'Settings');

  expect(wsClosed).toBe(false);
  await expect(page.getByText('Connection lost, reconnecting…')).toHaveCount(0);
  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});
