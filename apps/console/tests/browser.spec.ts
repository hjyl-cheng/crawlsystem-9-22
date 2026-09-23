import { test, expect, type Page } from '@playwright/test';
import { CONTRACT_VERSION, type PlanDetail, type Role, type CreatePlan, type Worker } from '@crawlsystem/contracts';
import { detailFixture, channelFixture, workerFixture, errorFixture } from './fixtures.js';

async function mock(page: Page, detail?: PlanDetail, role: Role = 'operator') {
  const state = { detail, role, authenticated: false, fail: false, malformed: false, conflict: false, forbidden: false, loseCreate: false, creates: [] as CreatePlan[], cancels: [] as { command_id: string; expected_version: number }[], reads: [] as string[], workers: [] as Worker[], errors: detail ? [errorFixture(detail.plan.plan_id)] : [], pageTwo: false };
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url()); const path = url.pathname.replace('/api', ''); const method = route.request().method();
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    const failure = (status: number, code: string) => json({ error: { code, message: `测试替身：${code}`, retryable: status === 503, correlation_id: 'fixture-correlation' } }, status);
    const session = { subject: 'browser-fixture', workspace_id: 'console-browser-fixture', role: state.role, contract_version: CONTRACT_VERSION };
    if (path === '/v1/auth/login') { state.authenticated = true; return json(session); }
    if (path === '/v1/auth/logout') { state.authenticated = false; return json({ ok: true }); }
    if (path === '/v1/session') return state.authenticated ? json(session) : failure(401, 'UNAUTHENTICATED');
    if (method === 'GET') state.reads.push(url.pathname + url.search);
    if (state.fail) return failure(503, 'UNAVAILABLE');
    if (state.malformed) return json({ unexpected: true });
    if (path === '/v1/plans' && method === 'POST') {
      state.creates.push(route.request().postDataJSON());
      if (state.forbidden) return failure(403, 'FORBIDDEN');
      state.detail ??= detailFixture({ required_domains: state.creates[0]!.required_domains });
      if (state.loseCreate) { state.loseCreate = false; return route.abort('failed'); }
      await new Promise(resolve => setTimeout(resolve, 80));
      return json(state.detail.plan);
    }
    if (path.endsWith('/cancel')) {
      state.cancels.push(route.request().postDataJSON());
      if (state.forbidden) return failure(403, 'FORBIDDEN');
      if (state.conflict) return failure(409, 'CONFLICT');
      if (state.detail) { state.detail.plan.status = 'CANCELLED'; state.detail.plan.version++; state.detail.plan.finished_at = '2026-09-23T08:10:00.000Z'; return json(state.detail.plan); }
    }
    if (path === '/v1/plans') {
      const matches = state.detail && (!url.searchParams.get('status') || url.searchParams.get('status') === state.detail.plan.status);
      return json({ items: matches && url.searchParams.get('cursor') !== '20' ? [state.detail!.plan] : [], next_cursor: state.pageTwo && url.searchParams.get('cursor') === '0' ? '20' : null });
    }
    if (path.startsWith('/v1/plans/')) return state.detail ? json(state.detail) : failure(404, 'NOT_FOUND');
    if (path === '/v1/channels') return json({ items: state.detail ? [{ channel_id: state.detail.plan.channel_id, title: 'M1 固定样本频道', source_mode: 'fixture', updated_at: state.detail.plan.updated_at, latest_plan_id: state.detail.plan.plan_id, country: null, subscriber_count: 100, stored_videos: 1, latest_plan_status: state.detail.plan.status }] : [], next_cursor: null });
    if (path.startsWith('/v1/channels/') && state.detail) return json(channelFixture(state.detail.plan));
    if (path === '/v1/overview/plans') {
      const p = state.detail?.plan, by_status = { QUEUED: 0, RUNNING: 0, WAITING: 0, COMPLETED: 0, CANCELLED: 0, FAILED: 0 };
      if (p) by_status[p.status]++;
      return json({ observed_at: '2026-09-23T08:00:00.000Z', total: p ? 1 : 0, by_status, created_24h: p ? 1 : 0, completed_24h: p?.status === 'COMPLETED' ? 1 : 0, avg_completion_seconds_24h: null,
        domains: p ? p.required_domains.map(domain => ({ domain, required: 1, applied: state.detail!.domains.some(d => d.domain === domain && d.state === 'APPLIED') ? 1 : 0 })) : [], waiting_reasons: [] });
    }
    if (path === '/v1/overview/completeness') {
      const required = state.detail?.plan.required_domains ?? [];
      const applied = state.detail ? state.detail.domains.filter(d => required.includes(d.domain) && d.state === 'APPLIED').map(d => d.domain) : [];
      const total = state.detail ? 1 : 0, lacks = (domain: string) => required.includes(domain as never) && !applied.includes(domain as never) ? 1 : 0;
      return json({ basis: 'latest_plan_required_domains', observed_at: '2026-09-23T08:00:00.000Z', total_channels: total,
        complete: total && applied.length === required.length ? 1 : 0, partial: total && applied.length > 0 && applied.length < required.length ? 1 : 0, missing: total && applied.length === 0 ? 1 : 0,
        missing_by_domain: { ABOUT: lacks('ABOUT'), VIDEO: lacks('VIDEO'), AGENT: lacks('AGENT') }, latest_channel_update_at: state.detail?.plan.updated_at ?? null, freshness: 'NOT_IMPLEMENTED' });
    }
    if (path === '/v1/workers') return json({ items: state.workers, next_cursor: null });
    if (path === '/v1/errors') return json({ items: state.errors, next_cursor: null });
    if (path.startsWith('/v1/receipts/') && state.detail) return json(state.detail.receipts.find(receipt => path.endsWith(receipt.submission_id)));
    return failure(404, 'NOT_FOUND');
  });
  return state;
}
async function login(page: Page, path = '/') {
  await page.goto(path); await page.getByLabel('账号', { exact: true }).fill('fixture'); await page.getByLabel('密码', { exact: true }).fill('browser-fixture-password'); await page.getByRole('button', { name: '进入控制台' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
}

test('empty overview is explicit; read-only users cannot create even through a direct URL', async ({ page }) => {
  await mock(page, undefined, 'reader'); await login(page);
  await expect(page.getByText('尚无登记的 Worker')).toBeVisible();
  await expect(page.getByText('尚无频道记录')).toBeVisible();
  await expect(page.getByRole('link', { name: '创建样本计划' })).toHaveCount(0);
  await page.goto('/plans/new'); // The authenticated session survives a full page reload.
  await expect(page.getByRole('alert')).toContainText('没有创建计划的权限');
  await expect(page.getByRole('button', { name: '创建并查看计划' })).toHaveCount(0);
});
test('waiting plans distinguish partially available data, unexecuted Agent and delivery', async ({ page }) => {
  const detail = detailFixture({ status: 'WAITING', required_domains: ['ABOUT', 'VIDEO', 'AGENT'] }, ['ABOUT', 'VIDEO']);
  await mock(page, detail); await login(page, `/plans/${detail.plan.plan_id}`);
  await expect(page.getByText('等待依赖', { exact: true })).toBeVisible();
  await expect(page.getByText(/部分必需领域已有入库结果/)).toBeVisible();
  await expect(page.getByText('本轮已完成', { exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: detail.plan.channel_id, exact: true }).click();
  await expect(page.getByText('Agent 尚未执行', { exact: true })).toBeVisible();
  await page.getByText('首屏评论 · 1 条已入库').click(); await expect(page.getByText('固定样本评论', { exact: true })).toBeVisible();
  await expect(page.getByText('点赞 0', { exact: false })).toBeVisible();
  await expect(page.getByText('未启用。已有采集数据不代表已完成对外交付。')).toBeVisible();
});
test('completed sample keeps Agent and delivery boundaries visible', async ({ page }) => {
  const detail = detailFixture({ status: 'COMPLETED' }, ['ABOUT', 'VIDEO']); await mock(page, detail); await login(page, `/plans/${detail.plan.plan_id}`);
  await expect(page.getByText('本轮已完成', { exact: true })).toBeVisible(); await expect(page.getByText('本轮已结束')).toBeVisible();
  await expect(page.getByRole('button', { name: '取消本轮' })).toHaveCount(0);
  await expect(page.locator('dd').filter({ hasText: /^未启用$/ })).toBeVisible();
});
test('rapid create clicks produce one request and one logical plan', async ({ page }) => {
  const state = await mock(page); await login(page, '/plans/new');
  await page.getByRole('button', { name: '创建并查看计划' }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(page.getByRole('heading', { name: '采集任务详情', exact: true })).toBeVisible(); expect(state.creates).toHaveLength(1);
  expect(state.creates[0]?.request_id).toMatch(/^[0-9a-f-]{36}$/);
});
test('lost creation response retries the original identity across navigation', async ({ page }) => {
  const state = await mock(page); state.loseCreate = true; await login(page, '/plans/new');
  await page.getByRole('button', { name: '创建并查看计划' }).click(); await expect(page.getByRole('alert')).toContainText('无法连接服务');
  await page.getByRole('link', { name: '返回计划列表' }).click(); await page.getByRole('link', { name: '创建样本计划' }).click();
  await page.getByRole('button', { name: '核对并重试本次创建' }).click(); await expect(page.getByRole('heading', { name: '采集任务详情', exact: true })).toBeVisible();
  expect(state.creates).toHaveLength(2); expect(state.creates[1]).toEqual(state.creates[0]);
});
test('cancel conflict requires explicit refresh and preserves the submitted expected version', async ({ page }) => {
  const detail = detailFixture({ status: 'WAITING' }); const state = await mock(page, detail); state.conflict = true;
  await login(page, `/plans/${detail.plan.plan_id}`); await page.getByRole('button', { name: '取消本轮', exact: true }).click();
  await page.getByRole('button', { name: '确认取消', exact: true }).click(); await expect(page.getByText('计划状态或版本已经变化。', { exact: false })).toBeVisible();
  expect(state.cancels).toHaveLength(1); expect(state.cancels[0]?.expected_version).toBe(1);
  state.detail!.plan.version = 2; state.conflict = false;
  await page.getByRole('button', { name: '刷新计划', exact: true }).click();
  await expect(page.getByRole('button', { name: '取消本轮', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '取消本轮', exact: true }).click(); await page.getByRole('button', { name: '确认取消', exact: true }).click();
  await expect(page.getByText('已取消', { exact: true })).toBeVisible(); expect(state.cancels[1]?.expected_version).toBe(2); expect(state.cancels[1]?.command_id).not.toBe(state.cancels[0]?.command_id);
});
test('backend permission denial is visible and never shown as successful cancellation', async ({ page }) => {
  const detail = detailFixture(); const state = await mock(page, detail); state.forbidden = true;
  await login(page, `/plans/${detail.plan.plan_id}`); await page.getByRole('button', { name: '取消本轮', exact: true }).click(); await page.getByRole('button', { name: '确认取消', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('没有执行此操作的权限'); await expect(page.getByRole('button', { name: '确认取消', exact: true })).toBeDisabled();
  await expect(page.getByText('已取消', { exact: true })).toHaveCount(0);
});
test('worker loss of heartbeat follows the server state', async ({ page }) => {
  const state = await mock(page); state.workers = [workerFixture()]; await login(page, '/workers'); await expect(page.getByText('心跳正常', { exact: true })).toBeVisible();
  state.workers[0]!.stale = true; await page.getByRole('button', { name: '刷新数据' }).click(); await expect(page.getByText('心跳失联', { exact: true })).toBeVisible();
  await expect(page.getByText('固定样本不使用代理', { exact: true })).toBeVisible();
});
test('error entry links to the correct plan and its persisted receipt', async ({ page }) => {
  const detail = detailFixture({ status: 'FAILED' }, ['ABOUT']); await mock(page, detail); await login(page, '/errors');
  await page.getByRole('button', { name: '查看错误关联' }).click(); await expect(page.getByRole('heading', { name: '错误关联', exact: true })).toBeVisible();
  await page.getByRole('link', { name: detail.receipts[0]!.submission_id }).click(); await expect(page.getByRole('heading', { name: '持久回执', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '查看对应 Plan' })).toHaveAttribute('href', `/plans/${detail.plan.plan_id}`);
});
test('network failure marks old results stale and manual refresh recovers', async ({ page }) => {
  const detail = detailFixture(); const state = await mock(page, detail); await login(page, '/plans'); await expect(page.getByRole('link', { name: detail.plan.plan_id })).toBeVisible();
  state.fail = true; await page.getByRole('button', { name: '刷新数据' }).click(); await expect(page.getByText('数据可能已过期。', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: detail.plan.plan_id })).toBeVisible(); state.fail = false; await page.getByRole('button', { name: '重新查询' }).click(); await expect(page.getByRole('alert')).toHaveCount(0);
});
test('malformed response does not become an empty successful page', async ({ page }) => {
  const state = await mock(page); state.malformed = true; await login(page, '/channels');
  await expect(page.getByRole('alert')).toContainText('公共契约不兼容'); await expect(page.getByText('尚无频道记录', { exact: true })).toHaveCount(0);
});
test('pagination and filtering issue bounded requests with no invented totals', async ({ page }) => {
  const state = await mock(page, detailFixture()); state.pageTwo = true; await login(page, '/plans');
  await page.getByRole('button', { name: '下一页' }).click(); await expect(page.getByText('没有符合条件的计划')).toBeVisible();
  expect(state.reads.some(url => url.includes('limit=20&cursor=20'))).toBe(true);
  await page.getByLabel('计划状态').selectOption('WAITING'); await expect(page).toHaveURL(/cursor=0.*status=WAITING/);
  expect(state.reads.every(url => !url.includes('limit=1000'))).toBe(true);
});
test('unauthenticated responses clear the visible workspace', async ({ page }) => {
  await mock(page, detailFixture()); await login(page, '/plans');
  await page.route('**/api/v1/plans?**', route => route.fulfill({ status: 401, json: { error: { code: 'UNAUTHENTICATED', message: 'expired', retryable: false, correlation_id: 'fixture-401' } } }));
  await page.getByRole('button', { name: '刷新数据' }).click(); await expect(page.getByRole('heading', { name: '连接工作空间' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '主导航' })).toHaveCount(0);
  expect(await page.evaluate(() => Object.values(localStorage).some(value => String(value).includes('browser-fixture-password')))).toBe(false);
});
test('leaving a list stops its polling; phone layout has a working navigation drawer', async ({ page }) => {
  const state = await mock(page, detailFixture()); await page.setViewportSize({ width: 390, height: 844 }); await login(page, '/plans');
  // The drawer is intentionally offscreen until opened on phones.
  await page.getByRole('button', { name: '打开导航' }).click(); await page.getByRole('link', { name: '频道管理', exact: true }).click(); await expect(page.getByRole('heading', { name: '频道管理', exact: true })).toBeVisible();
  const previous = state.reads.filter(url => url.startsWith('/api/v1/plans?')).length;
  await page.clock.install(); await page.clock.runFor(6_000);
  expect(state.reads.filter(url => url.startsWith('/api/v1/plans?')).length).toBe(previous);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('loading remains distinct from an empty successful result', async ({ page }) => {
  await mock(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v1/channels?**', async route => { await gate; await route.fulfill({ json: { items: [], next_cursor: null } }); });
  await login(page, '/channels');
  await expect(page.getByRole('status').filter({ hasText: '正在加载…' })).toBeVisible();
  await expect(page.getByText('尚无频道记录', { exact: true })).toHaveCount(0);
  release(); await expect(page.getByText('尚无频道记录', { exact: true })).toBeVisible();
});

test('continuous dependency failure reaches a finite polling budget', async ({ page }) => {
  const state = await mock(page, detailFixture()); await login(page, '/plans');
  await expect(page.getByRole('table').getByText('等待执行', { exact: true })).toBeVisible();
  await page.clock.install(); state.fail = true;
  const listReads = () => state.reads.filter(url => url.startsWith('/api/v1/plans?')).length;
  const count = listReads();
  await page.getByRole('button', { name: '刷新数据' }).click();
  await expect.poll(listReads).toBe(count + 1);
  for (let i = 2; i <= 5; i++) {
    await expect(page.getByRole('button', { name: '刷新数据' })).toBeEnabled();
    await page.clock.fastForward(60_000);
    await expect.poll(listReads).toBe(count + i);
  }
  await expect(page.getByRole('button', { name: '刷新数据' })).toBeEnabled();
  await page.clock.fastForward(60_000);
  await expect(page.getByText('自动更新已暂停，可点击刷新重新查询。')).toBeVisible();
  await page.clock.fastForward(600_000); expect(listReads()).toBe(count + 5);
});

test('overview completeness shows the backend aggregate, not counts derived from list pages', async ({ page }) => {
  await mock(page, detailFixture({ status: 'WAITING' }, ['ABOUT'])); await login(page);
  const card = page.locator('.completeness-card');
  await expect(card.getByText('数据完整性与新鲜度')).toBeVisible();
  await expect(card.locator('.completeness-metrics .blue strong')).toHaveText('1');
  await expect(card.locator('.completeness-metrics .green strong')).toHaveText('0');
  await expect(card.locator('.completeness-reasons div', { hasText: '视频 / 评论未入库' }).locator('b')).toHaveText('1');
  await expect(card.locator('.completeness-metrics .pending strong').first()).toHaveText('—');
});
test('desktop overview fits one screen and card columns line up', async ({ page }) => {
  await mock(page, detailFixture({ status: 'COMPLETED' }, ['ABOUT', 'VIDEO'])); await page.setViewportSize({ width: 1920, height: 937 }); await login(page);
  await expect(page.getByText('必需领域已入库', { exact: true })).toBeVisible();
  for (const [width, height] of [[1920, 937], [1586, 992]] as const) {
    await page.setViewportSize({ width, height });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
    const edges = await page.evaluate(() => [...document.querySelectorAll('.dashboard-row')].map(row => [...row.children].map(cell => Math.round(cell.getBoundingClientRect().left))));
    expect(edges[0]).toEqual(edges[1]);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBe(0);
});
test('overview polling updates the pipeline in place without hiding nodes or edges', async ({ page }) => {
  const state = await mock(page, detailFixture({ status: 'RUNNING' }, ['ABOUT'])); await page.clock.install(); await login(page);
  await expect(page.getByText('必需领域已入库', { exact: true })).toBeVisible();
  const visible = () => page.evaluate(() => {
    const nodes = [...document.querySelectorAll('#pipeline .react-flow__node')];
    return { hidden: nodes.filter(node => getComputedStyle(node).visibility === 'hidden').length, nodes: nodes.length, edges: document.querySelectorAll('#pipeline .react-flow__edge').length };
  });
  const before = await visible(); expect(before.hidden).toBe(0); expect(before.edges).toBe(10);
  const reads = state.reads.length;
  await page.clock.runFor(31_000);
  await expect.poll(() => state.reads.length).toBeGreaterThan(reads);
  await expect.poll(visible).toEqual(before);
});
test('query discovery shows no figures until the sample preview is switched on, and then warns', async ({ page }) => {
  await mock(page); await login(page, '/discover/queries');
  await expect(page.getByRole('heading', { name: 'Query 发现', exact: true })).toBeVisible();
  await expect(page.getByText('尚无 Query', { exact: true })).toBeVisible();
  await expect(page.locator('.discover-kpi strong').first()).toHaveText('—');
  await expect(page.getByText('以下为设计示例数据', { exact: false })).toHaveCount(0);
  await page.getByLabel('预览示例数据').check();
  await expect(page.getByText('以下为设计示例数据', { exact: false })).toBeVisible();
  await expect(page.locator('.discover-kpi strong').first()).toHaveText('1,284');
  await page.getByLabel('预览示例数据').uncheck();
  await expect(page.locator('.discover-kpi strong').first()).toHaveText('—');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
test('candidate channels show no figures until the sample preview is switched on, and then warn', async ({ page }) => {
  await mock(page); await login(page, '/discover/candidates');
  await expect(page.getByRole('heading', { name: '候选频道', exact: true })).toBeVisible();
  await expect(page.getByText('尚无候选频道', { exact: true })).toBeVisible();
  await expect(page.locator('.discover-kpi strong').first()).toHaveText('—');
  await expect(page.getByRole('button', { name: '选择文件' })).toBeDisabled();
  await page.getByLabel('预览示例数据').check();
  await expect(page.getByText('以下为设计示例数据', { exact: false })).toBeVisible();
  await expect(page.locator('.discover-kpi strong').first()).toHaveText('12,438');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel('预览示例数据')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
test('full collection shows backend plan statistics next to the real plan list', async ({ page }) => {
  await mock(page, detailFixture({ status: 'WAITING' }, ['ABOUT'])); await login(page, '/plans');
  await expect(page.getByRole('heading', { name: '全量采集', exact: true })).toBeVisible();
  await expect(page.locator('.status-cell.amber strong')).toHaveText('1');
  await expect(page.locator('.domain-bars div', { hasText: '频道基础信息' }).locator('b')).toHaveText('100.0%');
  await expect(page.locator('.domain-bars div', { hasText: '视频与评论' }).locator('b')).toHaveText('0.0%');
  await expect(page.getByText('以下为设计示例数据', { exact: false })).toHaveCount(0);
  await page.getByLabel('预览示例数据').check();
  await expect(page.getByText('以下为设计示例数据', { exact: false })).toBeVisible();
  await expect(page.locator('.discover-kpi strong').first()).toHaveText('156');
});
test('update collection shows no figures until the sample preview is switched on, and has no Clock menu', async ({ page }) => {
  await mock(page); await login(page, '/update');
  await expect(page.getByRole('heading', { name: '更新采集', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '主导航' }).getByText('Clock 调度')).toHaveCount(0);
  await expect(page.getByText('尚无更新任务', { exact: true })).toBeVisible();
  await expect(page.locator('.discover-kpi strong').first()).toHaveText('—');
  await page.getByLabel('预览示例数据').check();
  await expect(page.getByText('以下为设计示例数据', { exact: false })).toBeVisible();
  await expect(page.locator('.discover-kpi strong').first()).toHaveText('256');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
test('agent tasks show only the real waiting-plan count until the sample preview is switched on', async ({ page }) => {
  await mock(page, detailFixture({ status: 'WAITING', required_domains: ['ABOUT', 'VIDEO', 'AGENT'] }, ['ABOUT', 'VIDEO'])); await login(page, '/agent');
  await expect(page.getByRole('heading', { name: 'Agent 任务', exact: true })).toBeVisible();
  await expect(page.getByText('1 个计划的 Agent 结果未入库', { exact: false })).toBeVisible();
  await expect(page.getByText('尚无 Agent 任务', { exact: true })).toBeVisible();
  await page.getByLabel('预览示例数据').check();
  await expect(page.getByText('以下为设计示例数据', { exact: false })).toBeVisible();
  await page.getByRole('row', { name: /Web Forge/ }).click();
  await expect(page.locator('.agent-detail').getByText('本轮未产出有效画像', { exact: false })).toBeVisible();
  await page.getByRole('tab', { name: /失败/ }).click();
  await expect(page.locator('.agent-list tbody tr')).toHaveCount(1);
});
test('data API page covers collector-side external calls and shows no figures until the sample preview', async ({ page }) => {
  await mock(page); await login(page, '/data-api');
  await expect(page.getByRole('heading', { name: '数据 API', exact: true })).toBeVisible();
  await expect(page.getByText('尚无接口调用', { exact: true })).toBeVisible();
  await expect(page.getByText('调用趋势尚未接入', { exact: true })).toBeVisible();
  await page.getByLabel('预览示例数据').check();
  await expect(page.getByText('以下为设计示例数据', { exact: false })).toBeVisible();
  await expect(page.locator('.endpoint-list').getByRole('cell', { name: 'channels.list', exact: true })).toBeVisible();
  const chart = page.locator('.trend-box svg'); const box = (await chart.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
  await expect(page.locator('.trend-tip')).toContainText('成功');
});
test('delivery treats sent as unconfirmed and shows the real completed-plan count until the sample preview', async ({ page }) => {
  await mock(page, detailFixture({ status: 'COMPLETED' }, ['ABOUT', 'VIDEO'])); await login(page, '/delivery');
  await expect(page.getByRole('heading', { name: '发布交付', exact: true })).toBeVisible();
  await expect(page.getByText('1 个计划已完成采集', { exact: false })).toBeVisible();
  await expect(page.getByText('尚无交付记录', { exact: true })).toBeVisible();
  await page.getByLabel('预览示例数据').check();
  await page.getByRole('row', { name: /Deep Talk Pod/ }).click();
  await expect(page.locator('.delivery-detail').getByText('回执到达前不计为已交付', { exact: false })).toBeVisible();
  await page.getByRole('tab', { name: /已交付/ }).click();
  await expect(page.locator('.delivery-list tbody tr')).toHaveCount(3);
});
test('channel management lists real channel facts and shows the selected channel beside the list', async ({ page }) => {
  await mock(page, detailFixture({ status: 'COMPLETED' }, ['ABOUT', 'VIDEO'])); await login(page, '/channels');
  await expect(page.getByRole('heading', { name: '频道管理', exact: true })).toBeVisible();
  const row = page.locator('.channels-list tbody tr').first();
  await expect(row).toContainText('M1 固定样本频道'); await expect(row).toContainText('本轮已完成');
  await expect(page.locator('.channel-detail').getByText('已入库视频', { exact: true })).toBeVisible();
  await page.locator('.channel-detail').getByRole('tab', { name: '更新策略' }).click();
  await expect(page.locator('.channel-detail').getByText('未接入').first()).toBeVisible();
  await page.getByLabel('预览示例数据').check();
  await expect(page.getByText('以下为设计示例数据', { exact: false })).toBeVisible();
  await expect(page.locator('.channels-list tbody tr')).toHaveCount(10);
});
test('IP resource management replaces three proxy menus and reports the real proxy status of Workers', async ({ page }) => {
  const state = await mock(page); state.workers = [{ worker_id: 'w1', server_id: 'n1', build_version: 'v1', accepting_work: true, capacity: 1, running_plan_ids: [], last_heartbeat_at: '2026-09-23T08:00:00.000Z', stale: false, proxy_status: 'NOT_CONFIGURED' }];
  await login(page, '/proxies');
  const nav = page.getByRole('navigation', { name: '主导航' });
  await expect(nav.getByRole('link', { name: 'IP 资源管理' })).toBeVisible();
  for (const old of ['IP 管理', 'IP 分组', '服务器管理']) await expect(nav.getByText(old, { exact: true })).toHaveCount(0);
  await expect(page.getByText('1 个 Worker 未配置代理', { exact: false })).toBeVisible();
  await expect(page.getByText('尚无代理 IP', { exact: true })).toBeVisible();
  await page.getByLabel('预览示例数据').check();
  await expect(page.locator('.ip-list tbody tr')).toHaveCount(10);
  await expect(page.locator('.ip-list tbody')).toContainText('192.0.2.34');
});
test('worker management merges the node menus and shows real heartbeats with servers derived from them', async ({ page }) => {
  const state = await mock(page); state.workers = [workerFixture()]; await login(page, '/workers');
  const nav = page.getByRole('navigation', { name: '主导航' });
  await expect(nav.getByRole('link', { name: 'Worker 管理' })).toBeVisible();
  for (const old of ['采集节点', '服务器总览']) await expect(nav.getByText(old, { exact: true })).toHaveCount(0);
  await expect(page.locator('.row-servers tbody tr')).toHaveCount(1);
  await expect(page.locator('.row-servers tbody')).toContainText('fixture-node');
  await expect(page.locator('.worker-detail')).toContainText('fixture-worker');
  await expect(page.getByText('资源指标尚未接入（Prometheus）', { exact: false }).first()).toBeVisible();
  await page.getByLabel('预览示例数据').check();
  await expect(page.locator('.worker-list tbody tr')).toHaveCount(8);
});
