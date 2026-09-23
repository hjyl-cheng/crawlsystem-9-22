/** Actual Fastify + PostgreSQL browser tests. No route interception or fake API. */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  ApiRoutes, ApiErrorSchema, SessionSchema, PlanSchema, PlanInputSchema, PlanDetailSchema, ReceiptSchema,
  WorkerSchema, pageSchema, type CreatePlan, type PlanDetail,
} from '@crawlsystem/contracts';
import { fixtureSubmission, submissionHash } from '@crawlsystem/contracts/hash';
import { ApiFailure } from '../src/api.js';

const control = process.env.CONSOLE_CONTROL_URL || 'http://127.0.0.1:18100';
const ingest = process.env.CONSOLE_INGEST_URL || 'http://127.0.0.1:18101';
function token(name: string) {
  const path = process.env[name]; if (!path) throw new Error(`${name} must reference a private token file`);
  return readFileSync(path, 'utf8').trim();
}
const operator = token('CONSOLE_OPERATOR_TOKEN_FILE'), reader = token('CONSOLE_READER_TOKEN_FILE'), worker = token('CONSOLE_WORKER_TOKEN_FILE');
const evidenceDir = resolve('docs/evidence');
const evidence: Record<string, unknown> = { mode: 'actual Fastify + PostgreSQL; controlled fixture submissions, not Temporal execution', started_at: new Date().toISOString(), control, ingest };
async function request<T>(path: string, credential: string, schema: z.ZodType<T>, body?: unknown, base = control): Promise<T> {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${credential}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    const parsed = ApiErrorSchema.safeParse(await response.json());
    throw new ApiFailure(`Live API ${response.status}: ${parsed.success ? parsed.data.error.code : 'invalid error response'}`, response.status, parsed.success ? parsed.data.error.code : 'SCHEMA', parsed.success && parsed.data.error.retryable);
  }
  return schema.parse(await response.json());
}
async function login(page: Page, credential: string, path = '/') {
  await page.goto(path); await page.getByLabel('访问令牌', { exact: true }).fill(credential); await page.getByRole('button', { name: '进入控制台' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
}
async function createFromUi(page: Page, requireAgent = false) {
  await page.getByRole('link', { name: '创建样本计划' }).click();
  if (requireAgent) await page.getByRole('checkbox', { name: /Agent 分析/ }).check();
  const response = page.waitForResponse(r => new URL(r.url()).pathname.endsWith(ApiRoutes.plans) && r.request().method() === 'POST');
  await page.getByRole('button', { name: '创建并查看计划' }).click();
  const plan = PlanSchema.parse(await (await response).json());
  await expect(page.getByRole('heading', { name: 'Plan 详情', exact: true })).toBeVisible(); return plan;
}
async function apply(planId: string, domain: 'ABOUT'|'VIDEO') {
  const context = await request(ApiRoutes.input(planId), worker, PlanInputSchema);
  return request(ApiRoutes.submissions, worker, ReceiptSchema, fixtureSubmission(context, domain), ingest);
}
async function refresh(page: Page) {
  await page.getByRole('button', { name: '刷新数据', exact: true }).first().click();
}
async function capture(page: Page, filename: string) {
  mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({ path: resolve(evidenceDir, filename), fullPage: true });
}
test.beforeAll(async () => {
  const identities = await Promise.all([operator, reader, worker].map(credential => request(ApiRoutes.session, credential, SessionSchema)));
  expect(new Set(identities.map(identity => identity.workspace_id)).size).toBe(1);
  if (!identities[0]!.workspace_id.startsWith('console-e2e-')) throw new Error('Live tests require a dedicated console-e2e-* workspace.');
  expect(identities.map(i => i.role)).toEqual(['operator', 'reader', 'worker']); evidence.workspace_id = identities[0]!.workspace_id;
});
test.afterAll(() => {
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(resolve(evidenceDir, 'live-results.json'), JSON.stringify({ ...evidence, finished_at: new Date().toISOString() }, null, 2) + '\n');
});

test('create → partial data → wait → locate error and receipt → version conflict → cancel', async ({ page, browser }) => {
  evidence.browser = browser.version(); await login(page, operator, '/plans');
  const plan = await createFromUi(page, true); evidence.waiting_plan_id = plan.plan_id;
  const about = await apply(plan.plan_id, 'ABOUT'); await refresh(page);
  await expect(page.getByText(/部分必需领域已有入库结果（1 \/ 3）/)).toBeVisible();
  const video = await apply(plan.plan_id, 'VIDEO'); await refresh(page);
  await expect(page.getByText('等待依赖', { exact: true })).toBeVisible();
  await expect(page.getByText(/部分必需领域已有入库结果（2 \/ 3）/)).toBeVisible();
  const workerSession = await request(ApiRoutes.session, worker, SessionSchema);
  const eventId = randomUUID();
  await request(ApiRoutes.events(plan.plan_id), worker, z.object({ accepted: z.literal(true) }), { event_id: eventId, execution_epoch: plan.execution_epoch, worker_id: workerSession.subject, phase: 'console-e2e-ingest', kind: 'ERROR', domain: 'VIDEO', message: '控制台 E2E：受控错误事件，用于验证 Plan 与持久回执定位。', error_code: 'UNAVAILABLE' });
  await refresh(page); await capture(page, 'live-plan-waiting.png');
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '采集总览' }).click();
  await expect(page.getByText('必需领域已入库', { exact: true })).toBeVisible(); await capture(page, 'live-overview.png');
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '错误与追踪' }).click();
  await page.getByRole('button', { name: '查看错误关联' }).first().click();
  await page.getByRole('link', { name: about.submission_id, exact: true }).click(); await expect(page.getByRole('heading', { name: '持久回执', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '查看对应 Plan' }).click();
  await page.getByRole('button', { name: '取消本轮', exact: true }).click();
  // Change the durable version after the confirmation captured its expected version.
  await request(ApiRoutes.events(plan.plan_id), worker, z.object({ accepted: z.literal(true) }), { event_id: randomUUID(), execution_epoch: plan.execution_epoch, worker_id: workerSession.subject, phase: 'console-e2e-version-change', kind: 'STARTED', domain: null, message: '控制台 E2E：验证过期版本取消被拒绝。' });
  await page.getByRole('button', { name: '确认取消', exact: true }).click(); await expect(page.getByText(/计划状态或版本已经变化/)).toBeVisible();
  await page.getByRole('button', { name: '刷新计划', exact: true }).click(); await expect(page.getByRole('button', { name: '取消本轮', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '取消本轮', exact: true }).click(); await page.getByRole('button', { name: '确认取消', exact: true }).click();
  await expect(page.getByText('已取消', { exact: true })).toBeVisible(); await capture(page, 'live-plan-cancelled.png');
  const durable = await request(ApiRoutes.plan(plan.plan_id), operator, PlanDetailSchema); expect(durable.plan.status).toBe('CANCELLED');
  // A new late result cannot replay an existing receipt by accident.
  const context = await request(ApiRoutes.input(plan.plan_id), worker, PlanInputSchema);
  const late = fixtureSubmission(context, 'VIDEO'); late.submission_id = randomUUID(); late.payload_hash = submissionHash(late);
  const rejection = await fetch(ingest + ApiRoutes.submissions, { method: 'POST', headers: { Authorization: `Bearer ${worker}`, 'Content-Type': 'application/json' }, body: JSON.stringify(late) });
  expect(rejection.status).toBe(409); expect(ApiErrorSchema.parse(await rejection.json()).error.code).toBe('PLAN_TERMINAL');
  evidence.waiting_scenario = { result: 'passed', plan_id: plan.plan_id, receipts: [about.submission_id, video.submission_id], error_event_id: eventId, final_status: durable.plan.status };
});

test('complete sample and channel comments match the actual API; reader writes are rejected', async ({ page }) => {
  await login(page, operator, '/plans'); const plan = await createFromUi(page); await apply(plan.plan_id, 'ABOUT'); await apply(plan.plan_id, 'VIDEO'); await refresh(page);
  await expect(page.getByText('本轮已完成', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: plan.channel_id, exact: true }).click(); await expect(page.getByRole('heading', { name: 'M1 固定样本频道', exact: true })).toBeVisible();
  await page.getByText('首屏评论 · 1 条已入库').click(); await expect(page.getByText('固定样本评论', { exact: true })).toBeVisible();
  await expect(page.getByText('Agent 尚未执行', { exact: true })).toBeVisible(); await capture(page, 'live-channel.png');
  await page.getByRole('button', { name: '退出登录' }).click(); await page.getByLabel('访问令牌', { exact: true }).fill(reader); await page.getByRole('button', { name: '进入控制台' }).click();
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: 'Plan 管理' }).click();
  await expect(page.getByRole('link', { name: '创建样本计划' })).toHaveCount(0);
  const body: CreatePlan = { request_id: randomUUID(), fixture_id: 'channel-basic-v1', required_domains: ['ABOUT', 'VIDEO'] };
  const response = await fetch(control + ApiRoutes.plans, { method: 'POST', headers: { Authorization: `Bearer ${reader}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  expect(response.status).toBe(403); expect(ApiErrorSchema.parse(await response.json()).error.code).toBe('FORBIDDEN');
  const denial = await fetch(control + ApiRoutes.cancel(plan.plan_id), { method: 'POST', headers: { Authorization: `Bearer ${reader}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ command_id: randomUUID(), expected_version: plan.version }) });
  expect(denial.status).toBe(403);
  evidence.completed_scenario = { result: 'passed', plan_id: plan.plan_id, reader_create_status: response.status, reader_cancel_status: denial.status };
});

test('a registered worker becomes stale after real server heartbeat expiry', async ({ page }) => {
  test.setTimeout(140_000);
  const identity = await request(ApiRoutes.session, worker, SessionSchema);
  await request(ApiRoutes.heartbeat, worker, WorkerSchema, { worker_id: identity.subject, server_id: 'console-e2e-node', build_version: 'm1.v1-console-e2e', accepting_work: true, capacity: 1, running_plan_ids: [] });
  await login(page, operator, '/workers'); await expect(page.getByText('心跳正常', { exact: true })).toBeVisible();
  let transientFailures = 0;
  await expect.poll(async () => {
    try { return (await request(`${ApiRoutes.workers}?limit=20&cursor=0`, operator, pageSchema(WorkerSchema))).items.find(w => w.worker_id === identity.subject)?.stale; }
    catch (error) {
      if (error instanceof ApiFailure && error.retryable) { transientFailures++; return undefined; }
      throw error;
    }
  }, { timeout: 110_000, intervals: [10_000] }).toBe(true);
  await refresh(page); await expect(page.getByText('心跳失联', { exact: true })).toBeVisible(); await capture(page, 'live-worker-stale.png');
  evidence.heartbeat_scenario = { result: 'passed', worker_id: identity.subject, stale: true, transient_dependency_failures: transientFailures, source: 'server clock; no DB mutation or mocked heartbeat threshold' };
});
