// Playwright config for regenerating Linux parity baselines on the same
// ubuntu-24.04 runner as CI (see parity-baselines.json). It mirrors
// playwright.config.ts and targets the dev server started by linux-baseline.sh.
import { defineConfig, devices } from '@playwright/test';

const base = process.env.LINUX_BASELINE_BASE_URL ?? 'http://127.0.0.1:5174';

export default defineConfig({
  testDir: '../..',
  testMatch: '**/parity.spec.ts',
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: base,
    ignoreHTTPSErrors: true,
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
});
