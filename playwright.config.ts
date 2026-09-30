import { defineConfig, devices } from '@playwright/test';

const offset = Number(process.env.PORT_OFFSET ?? '0');
if (!Number.isInteger(offset) || offset < 0 || offset > 10_000) {
  throw new Error('PORT_OFFSET must be an integer from 0 to 10000');
}
const webUrl = `https://127.0.0.1:${String(5173 + offset)}`;

export default defineConfig({
  testDir: './e2e',
  // Both browser projects mutate a shared seeded Postgres database. Keep CI
  // sequential so fixture state and rate-limit rows cannot race across tests.
  fullyParallel: process.env.CI !== 'true',
  ...(process.env.CI ? { workers: 1 } : {}),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: webUrl,
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
      },
    },
    { name: 'webkit-mobile', use: { ...devices['iPhone 13'] } },
  ],
  webServer: {
    command: 'node scripts/dev.mjs --e2e',
    // Wait through Vite's API proxy as well as the page server; the API
    // listener can start after Vite, and page-only readiness races its first
    // authenticated requests on slower Linux CI workers.
    url: `${webUrl}/healthz`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
