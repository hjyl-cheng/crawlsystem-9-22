/** Browser acceptance of facts produced by the real Temporal recovery run. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { preview } from 'vite';
import { PlanDetailSchema } from '@crawlsystem/contracts';
import { Store } from '@crawlsystem/store';
import { createPool } from '@crawlsystem/store/config';
import { PgConsoleSessions } from '@crawlsystem/store/console-sessions';
import { createControlApi } from '../../apps/control-api/src/app.ts';
import { ConsoleAuth, passwordRecord } from '../../apps/control-api/src/console-auth.ts';

const result = JSON.parse(readFileSync('.runtime/execution-evidence/results.json', 'utf8'));
assert.equal(result.result, 'PASSED');
const completed = PlanDetailSchema.parse(result.plans.recovered), cancelled = PlanDetailSchema.parse(result.plans.waiting);
const workspace = completed.plan.workspace_id;
assert.match(workspace, /^main-joint-/);
assert.equal(cancelled.plan.workspace_id, workspace);
const pool = createPool(), store = new Store(pool), password = randomBytes(24).toString('base64url');
const account = { username: 'joint-browser', subject: 'joint-browser-reader', workspace_id: workspace, role: 'reader' as const, ...await passwordRecord(password) };
const origin = 'http://127.0.0.1:18114';
const app = createControlApi({ store, signingKey: randomBytes(48), allowedOrigin: origin, consoleAuth: new ConsoleAuth([account], false, Date.now, new PgConsoleSessions(pool)) });
let frontend: Awaited<ReturnType<typeof preview>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const current = await store.getInput({ workspace_id: workspace, subject: account.subject, role: 'reader' }, completed.plan.plan_id);
  assert.equal(current.plan.status, 'COMPLETED'); assert.deepEqual(current.receipts, completed.receipts);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  frontend = await preview({ configFile: false, root: resolve('apps/console'), logLevel: 'error', preview: { host: '127.0.0.1', port: 18114, strictPort: true, proxy: { '/api': { target: address, rewrite: path => path.replace(/^\/api/, '') } } } });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1586, height: 992 } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.name));
  await page.goto(origin + `/plans/${completed.plan.plan_id}`);
  await page.getByLabel('账号', { exact: true }).fill(account.username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '进入控制台' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  await page.goto(origin + `/plans/${completed.plan.plan_id}`);
  await expect(page.getByText('本轮已完成', { exact: true })).toBeVisible();
  await expect(page.getByText(completed.plan.workflow_id, { exact: true })).toBeVisible();
  for (const receipt of completed.receipts) await expect(page.getByRole('link', { name: receipt.submission_id, exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: result.worker.worker_id, exact: true }).first()).toBeVisible();
  const output = 'docs/m1/reports'; mkdirSync(output, { recursive: true });
  await page.screenshot({ path: `${output}/main-execution-browser.png`, fullPage: true });
  await page.goto(origin + `/plans/${cancelled.plan.plan_id}`);
  await expect(page.getByText('已取消', { exact: true })).toBeVisible();
  await expect(page.getByText(cancelled.plan.workflow_id, { exact: true })).toBeVisible();
  assert.equal(cancelled.domains.find(domain => domain.domain === 'AGENT')?.state, 'PENDING');
  assert.deepEqual(errors, []);
  const evidence = { verified_at: new Date().toISOString(), scope: 'Browser + real Control/PG reads of Temporal-produced facts; no driver-submitted fixtures',
    workspace_id: workspace, completed_plan_id: completed.plan.plan_id, cancelled_plan_id: cancelled.plan.plan_id,
    workflow_id: completed.plan.workflow_id, worker_id: result.worker.worker_id, receipt_ids: completed.receipts.map(receipt => receipt.submission_id),
    checks: ['real completed Plan', 'same Workflow identity', 'same Worker events', 'same APPLIED receipts', 'cancelled Plan with AGENT pending'], browser_errors: errors.length };
  writeFileSync(`${output}/main-execution-browser.json`, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  console.error({ failure: String(error).split('\n')[0] }); process.exitCode = 1;
} finally {
  await browser?.close();
  if (frontend) await new Promise<void>((done, reject) => frontend!.httpServer.close(error => error ? reject(error) : done()));
  await app.close(); await pool.end();
}
