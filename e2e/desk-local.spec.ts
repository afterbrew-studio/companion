import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { startDaemon, waitForHealthz } from '../scripts/smoke-install.mjs';

interface Daemon {
  readonly home: string;
  readonly baseUrl: string;
  readonly proc: { exitCode: number | null; kill(signal?: NodeJS.Signals): void };
  logTail(count?: number): string;
  stop(): Promise<number | string>;
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const packagedStaticDir = join(repoRoot, 'apps', 'companion-cli', 'dist', 'web');
let daemon: Daemon;

test.beforeAll(async () => {
  if (!existsSync(join(packagedStaticDir, 'desk', 'index.html'))) {
    throw new Error('packaged Desk bundle missing: run `pnpm --filter @moxxy/companion bundle` first');
  }
  daemon = (await startDaemon({
    env: {
      COMPANION_AUTH_MODE: 'local',
      COMPANION_STATIC_DIR: packagedStaticDir,
    },
  })) as Daemon;
  await waitForHealthz(daemon);
});

test.afterAll(async () => {
  if (!daemon) return;
  const exit = await daemon.stop();
  expect(exit, 'daemon should exit cleanly on SIGTERM').toBe(0);
  await rm(daemon.home, { recursive: true, force: true });
});

test('packaged Desk bootstraps a trusted loopback session without a login screen', async ({ page }) => {
  const errors: string[] = [];
  let deskReady = false;
  page.on('console', (message) => {
    // `/me` truthfully answers 401 before AuthProvider obtains the trusted
    // loopback cookie. Match the full-app bootstrap test and only treat errors
    // after the authenticated Desk is visible as application failures.
    if (message.type() === 'error' && deskReady) errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));

  await page.goto(`${daemon.baseUrl}/desk/`);

  const navigation = page.getByRole('navigation', { name: 'Desk' });
  await expect(navigation).toBeVisible();
  await expect(navigation.getByRole('button', { name: 'Overview' })).toBeVisible();
  await expect(navigation.getByRole('button', { name: 'Missions' })).toBeVisible();
  await expect(navigation.getByRole('button', { name: 'Activity' })).toBeVisible();
  await expect(navigation.getByRole('button', { name: 'Terminal' })).toBeVisible();
  await expect(page.getByLabel('Sign in')).toHaveCount(0);
  deskReady = true;

  const session = await page.evaluate(async () => {
    const response = await fetch('/api/auth/me');
    return { status: response.status, body: await response.json() };
  });
  expect(session.status).toBe(200);
  expect(session.body.user.role).toBe('admin');
  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});
