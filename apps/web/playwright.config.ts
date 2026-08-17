import { defineConfig, devices } from '@playwright/test';

import { rendererOrigin } from './e2e/fixtures.js';

const baseURL = 'http://127.0.0.1:43873';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  outputDir: './test-results',
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  expect: { timeout: 5_000 },
  use: {
    baseURL,
    colorScheme: 'dark',
    locale: 'en-US',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1_440, height: 900 } },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'], viewport: { width: 1_440, height: 900 } },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'], viewport: { width: 1_440, height: 900 } },
    },
    {
      name: 'mobile-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 320, height: 800 } },
    },
    {
      name: 'zoom-200-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 720, height: 450 } },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @shelf/web build && node e2e/browser-fixture-server.mjs',
      url: baseURL,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command:
        'pnpm --filter @shelf/renderer build && node ../renderer/test/browser-fixture-server.mjs',
      url: rendererOrigin,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
