import { fileURLToPath } from 'node:url';

import { defineConfig, devices } from '@playwright/test';

const offset = Number(process.env.PORT_OFFSET ?? '0');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const baseURL = `https://127.0.0.1:${String(5173 + offset)}`;

export default defineConfig({
  testDir: '.',
  testMatch: 'platform.e2e.spec.ts',
  fullyParallel: false,
  reporter: 'list',
  use: { baseURL, ignoreHTTPSErrors: true },
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
    cwd: root,
    url: baseURL,
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
