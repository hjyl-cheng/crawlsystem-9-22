import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {chromium,expect} from '@playwright/test';
import {issueToken,loadSigningKey} from '@crawlsystem/http/auth';
import {createPool} from '@crawlsystem/store/config';
import {ProxyAvailabilitySchema} from '../../packages/contracts/src/proxy-availability.ts';
const dir='.runtime/d4',origin='http://127.0.0.1:18103',workspace='m1-main';mkdirSync(dir,{recursive:true,mode:0o700});
const key=loadSigningKey(),token=await issueToken({subject:'d4-live',workspace_id:workspace,role:'operator'},key,600);
const headers={authorization:'Bearer '+token},pool=createPool(),browser=await chromium.launch({headless:true});
const evidence:Record<string,unknown>={},errors:string[]=[],failed:string[]=[];let phase='samples';
const get=async(query='')=>{const r=await fetch(origin+'/api/v1/proxies/availability'+query,{headers,signal:AbortSignal.timeout(15000)});assert.equal(r.status,200);return ProxyAvailabilitySchema.parse(await r.json());};
try{
  let day=await get();
  await expect.poll(async()=>{day=await get();return day.summary.samples;},{timeout:60000,intervals:[2000]}).toBeGreaterThan(0);
  const initial=day.summary.samples;
  await expect.poll(async()=>{day=await get();return day.summary.samples;},{timeout:60000,intervals:[2000]}).toBeGreaterThan(initial);
  const hour=await get('?resolution=hour');assert.equal(day.points.length,7);assert.equal(hour.points.length,24);assert.equal(day.stale,false);assert.ok(day.latest_report_at);assert.ok(day.summary.available_percent!==null);
  const blankBeforeStart=day.points.filter(p=>Date.parse(p.bucket_at)+86400000<=Date.parse(day.recording_since));
  assert.ok(blankBeforeStart.length>0);assert.ok(blankBeforeStart.every(p=>p.counts.samples===0&&p.counts.available_percent===null&&p.counts.request_success_percent===null));
  evidence.initial_samples=initial;evidence.day=day;evidence.hour=hour;evidence.missing_history_not_fabricated=true;
  const groups=(await pool.query("SELECT server_id,provider FROM control.proxy_availability_hourly WHERE workspace_id=$1 ORDER BY last_report_at DESC LIMIT 1",[workspace])).rows[0];assert.ok(groups);
  phase='filters';const filter='?resolution=hour&'+new URLSearchParams(groups).toString();const filtered=await get(filter);assert.ok(filtered.summary.samples>0);assert.ok(filtered.summary.samples<=(await get('?resolution=hour')).summary.samples);evidence.filtered=filtered;
  for(const role of ['reader','node','worker'] as const){
    const t=await issueToken({subject:'d4-'+role,workspace_id:workspace,role,...(role==='node'?{server_id:groups.server_id}:{})},key,600);
    const r=await fetch(origin+'/api/v1/proxies/availability',{headers:{authorization:'Bearer '+t},signal:AbortSignal.timeout(15000)});assert.equal(r.status,role==='reader'?200:403);
  }
  const isolated=await issueToken({subject:'d4-isolated',workspace_id:'d4-absent-'+randomUUID(),role:'reader'},key,600);
  const absent=await fetch(origin+'/api/v1/proxies/availability',{headers:{authorization:'Bearer '+isolated},signal:AbortSignal.timeout(15000)});
  const empty=ProxyAvailabilitySchema.parse(await absent.json());assert.equal(empty.summary.samples,0);assert.equal(empty.summary.available_percent,null);assert.equal(empty.summary.request_success_percent,null);assert.equal(empty.stale,true);
  evidence.workspace_isolation=true;evidence.machine_read_status=403;evidence.reader_read_status=200;
  phase='page';const page=await browser.newPage({viewport:{width:1920,height:937},extraHTTPHeaders:headers});
  page.on('pageerror',e=>errors.push(e.name));page.on('response',r=>{if(r.url().includes('/api/v1/')&&r.status()>=400)failed.push(new URL(r.url()).pathname+':'+r.status());});
  await page.goto(origin+'/proxies');const panel=page.locator('.proxy-availability');await expect(panel.getByRole('img',{name:'近 7 天代理可用率'})).toBeVisible();await expect(panel).toContainText('次观测');
  await expect(panel.locator('svg circle')).not.toHaveCount(0);
  await page.getByLabel('趋势时间范围').selectOption('hour');await expect(panel.getByRole('img',{name:'近 24 小时代理可用率'})).toBeVisible();
  await page.getByLabel('趋势服务器').selectOption(groups.server_id);await page.getByLabel('趋势服务商').selectOption(groups.provider);
  await expect(panel).toContainText('次观测');await page.getByLabel('趋势指标').selectOption('request_success_percent');await expect(panel.getByRole('img',{name:'近 24 小时请求成功率'})).toBeVisible();
  await page.getByLabel('趋势服务器').selectOption('');await page.getByLabel('趋势服务商').selectOption('');await page.getByLabel('趋势时间范围').selectOption('day');await page.getByLabel('趋势指标').selectOption('available_percent');
  phase='layouts';const layouts=[];
  for(const [width,height] of [[1920,937],[1586,992],[390,844]] as const){
    await page.setViewportSize({width,height});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBe(0);
    if(width<=680)await expect.poll(()=>page.locator('.sidebar').evaluate(n=>n.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
    await page.screenshot({path:dir+'/proxies-'+width+'.png',fullPage:true});layouts.push({width,height,horizontal_overflow:0});
  }
  evidence.layouts=layouts;assert.equal(failed.length,0);
  phase='error-recovery';await page.route('**/api/v1/proxies/availability?**',route=>route.fulfill({status:503,json:{error:{code:'UNAVAILABLE',message:'D4 页面错误恢复验证',retryable:true,correlation_id:'d4-browser'}}}));
  await page.getByRole('button',{name:'刷新趋势'}).click();await expect(panel.getByRole('alert')).toContainText('趋势读取失败');
  await page.unroute('**/api/v1/proxies/availability?**');await page.getByRole('button',{name:'刷新趋势'}).click();await expect(panel.getByRole('alert')).toHaveCount(0);evidence.error_recovered=true;
  phase='reader';const reader=await issueToken({subject:'d4-reader-browser',workspace_id:workspace,role:'reader'},key,600);
  const readonly=await browser.newPage({viewport:{width:390,height:844},extraHTTPHeaders:{authorization:'Bearer '+reader}});await readonly.goto(origin+'/proxies');await expect(readonly.locator('.proxy-availability')).toContainText('次观测');await expect(readonly.getByRole('button',{name:'添加 IP'})).toBeDisabled();
  const blank=await browser.newPage({viewport:{width:390,height:844},extraHTTPHeaders:{authorization:'Bearer '+isolated}});await blank.goto(origin+'/proxies');await expect(blank.locator('.proxy-availability')).toContainText('当前筛选尚无观测');await expect(blank.locator('.proxy-availability svg circle')).toHaveCount(0);evidence.empty_page=true;
  assert.equal(errors.length,0);writeFileSync(dir+'/browser-evidence.json',JSON.stringify({result:'PASSED',at:new Date().toISOString(),...evidence,page_errors:errors,unexpected_api_failures:failed.filter(p=>!p.endsWith(':503'))},null,2),{mode:0o600});
  console.log('D4 live samples grow; 7/24 buckets, filters, missing history, permissions, error recovery and responsive layouts passed');
}catch(error){writeFileSync(dir+'/browser-failure.json',JSON.stringify({phase,error:error instanceof Error?error.name:'UnknownError',...evidence,page_errors:errors,failed_api_reads:failed},null,2),{mode:0o600});console.error('D4 verification failed at '+phase);process.exitCode=1;}
finally{await browser.close();await pool.end();}
