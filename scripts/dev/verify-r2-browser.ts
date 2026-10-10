import { chromium, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { issueToken, loadSigningKey } from '@crawlsystem/http/auth';
const token = await issueToken({ subject: 'r2-browser-reader', workspace_id: 'm1-main', role: 'reader' }, loadSigningKey(), 600);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1586, height: 992 }, extraHTTPHeaders: { authorization: `Bearer ${token}` } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.name));
  await page.goto('http://127.0.0.1:18103/workers');
  await expect(page.getByRole('heading', { name: 'Worker 管理', exact: true })).toBeVisible();
  await expect(page.getByText('网页采集', { exact: true })).toBeVisible();
  await expect(page.getByText('pt-BR / BR', { exact: true })).toBeVisible();
  await expect(page.getByText('America/Sao_Paulo', { exact: true })).toBeVisible();
  await page.screenshot({ path: '.runtime/r2/workers.png', fullPage: true });
  await page.goto('http://127.0.0.1:18103/proxies');
  await expect(page.getByRole('columnheader', { name: '出口要求' })).toBeVisible();
  await expect(page.getByText(/强制巴西出口关闭/)).toBeVisible();
  await page.screenshot({ path: '.runtime/r2/proxies.png', fullPage: true });
  const id = readFileSync('.runtime/r2/current-plan','utf8').trim();
  await page.goto(`http://127.0.0.1:18103/plans/${id}`);
  await expect(page.getByRole('heading', { name: '采集任务详情', exact: true })).toBeVisible();
  await expect(page.getByText(/identity=browser:/).first()).toBeVisible();
  await page.screenshot({ path: '.runtime/r2/plan.png', fullPage: true });
  if (errors.length) throw new Error('Browser runtime errors');
  console.log(JSON.stringify({ result: 'PASSED', pages: ['workers','proxies','plan-detail'], errors: errors.length }));
} finally { await browser.close(); }
