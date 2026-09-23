import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    headless: true,
    // Local macOS can use an installed Chrome when the pinned Chromium
    // download is unavailable. CI continues to use Playwright's browser.
    channel: process.env.PLAYWRIGHT_CHROME_CHANNEL || undefined,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
