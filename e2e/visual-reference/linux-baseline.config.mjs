// Playwright config for regenerating the Linux parity baselines inside the
// mcr.microsoft.com/playwright container (see parity-baselines.json). It
// mirrors playwright.config.ts but targets the dev server running on the host
// via host.docker.internal instead of spawning its own webServer.
import { defineConfig, devices } from '@playwright/test';

const base =
  process.env.LINUX_BASELINE_BASE_URL ?? 'https://host.docker.internal:9713';

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
