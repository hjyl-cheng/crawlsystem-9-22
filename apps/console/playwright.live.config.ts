import { defineConfig } from '@playwright/test';

for (const name of ['CONSOLE_OPERATOR_TOKEN_FILE', 'CONSOLE_READER_TOKEN_FILE', 'CONSOLE_WORKER_TOKEN_FILE']) {
  if (!process.env[name]) throw new Error(`${name} is required: real API tests cannot use mock authentication.`);
}
export default defineConfig({
  testDir: './tests', testMatch: 'live.spec.ts', workers: 1, fullyParallel: false,
  timeout: 60_000, expect: { timeout: 12_000 },
  outputDir: 'test-results/live', reporter: [['list'], ['json', { outputFile: 'test-results/live-report.json' }]],
  // Never collect authorization headers, tokens, or network traces from live authentication.
  use: { baseURL: 'http://127.0.0.1:18102', viewport: { width: 1586, height: 992 }, trace: 'off', video: 'off', screenshot: 'off' },
  webServer: { command: 'npm run dev', env: { VITE_AUTH_MODE: 'token' }, url: 'http://127.0.0.1:18102', reuseExistingServer: false, timeout: 60_000 },
});
