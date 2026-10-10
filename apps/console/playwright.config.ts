import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: ['browser.spec.ts','analytics.spec.ts'], fullyParallel: true, workers: 2,
  timeout: 30_000, expect: { timeout: 8_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:18112', viewport: { width: 1586, height: 992 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'npm run dev -- --port 18112', url: 'http://127.0.0.1:18112', reuseExistingServer: false, timeout: 60_000 },
});
