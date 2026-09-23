import { defineConfig } from '@playwright/test';
if (!process.env.CONSOLE_LOGIN_FILE || !process.env.CONSOLE_PREVIEW_URL) throw new Error('CONSOLE_LOGIN_FILE and CONSOLE_PREVIEW_URL are required');
export default defineConfig({
  testDir: './tests', testMatch: 'password-live.spec.ts', workers: 1, timeout: 60_000,
  expect: { timeout: 15_000 }, outputDir: 'test-results/password-live', reporter: 'list',
  use: { baseURL: process.env.CONSOLE_PREVIEW_URL, viewport: { width: 1586, height: 992 }, trace: 'off', screenshot: 'off', video: 'off' },
});
