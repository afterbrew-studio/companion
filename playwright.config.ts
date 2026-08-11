import { defineConfig } from '@playwright/test';

/**
 * Browser-level smoke of the SPA shell (e2e/shell.spec.ts). The spec boots the
 * built daemon itself (reusing the smoke-install helpers), which then serves
 * apps/web/dist exactly like a production install, so there is no webServer
 * block here. Requires `pnpm -r build` and an installed chromium
 * (`npx playwright install chromium`).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
