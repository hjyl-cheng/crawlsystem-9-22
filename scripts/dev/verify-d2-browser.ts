import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
import {createPool} from '@crawlsystem/store/config';
import {issueToken,loadSigningKey} from '@crawlsystem/http/auth';
import {WorkerSchema,pageSchema,type Worker} from '@crawlsystem/contracts';
import {WorkerMetricsSchema} from '../../packages/contracts/src/workers.ts';
const dir='.runtime/d2',origin='http://127.0.0.1:18103',workspace='m1-main';mkdirSync(dir,{recursive:true,mode:0o700});
const token=await issueToken({subject:'d2-browser',workspace_id:workspace,role:'operator'},loadSigningKey(),600);
const reader=await issueToken({subject:'d2-reader',workspace_id:workspace,role:'reader'},loadSigningKey(),600);
const headers={authorization:'Bearer '+token},pool=createPool(),browser=await chromium.launch({headless:true});
const workers=async()=>{const r=await fetch(origin+'/api/v1/workers',{headers,signal:AbortSignal.timeout(15000)});assert.equal(r.status,200);return pageSchema(WorkerSchema).parse(await r.json()).items;};
let worker:Worker|undefined,restored=false,phase='ready';const errors:string[]=[],failed:string[]=[],evidence:Record<string,unknown>={};
const wait=async(check:(w:Worker)=>boolean,timeout=45000)=>expect.poll(async()=>{worker=(await workers()).find(w=>w.worker_id===worker?.worker_id);return !!worker&&check(worker);},{timeout,intervals:[2000]}).toBe(true);
try{
 worker=(await workers()).find(w=>w.management);assert.ok(worker);assert.equal(worker.control?.desired,'RUNNING','acceptance only changes a currently running Worker');
 await wait(w=>w.control?.status==='RUNNING');evidence.initial=worker;
 const page=await browser.newPage({viewport:{width:1920,height:937},extraHTTPHeaders:headers});
 page.on('pageerror',e=>errors.push(e.name));page.on('response',r=>{if(r.url().includes('/api/v1/')&&r.status()>=400)failed.push(new URL(r.url()).pathname+':'+r.status());});
 await page.goto(origin+'/workers?highlight='+worker.worker_id);await expect(page.locator('.worker-list tbody tr')).toHaveCount(1);
 await expect(page.getByRole('button',{name:'暂停接单',exact:true})).toBeEnabled();
 const metricResponse=await page.request.get(origin+'/api/v1/workers/'+worker.worker_id+'/metrics');assert.equal(metricResponse.status(),200);const metric=WorkerMetricsSchema.parse(await metricResponse.json());
 assert.ok(metric.monitoring_available);assert.ok(metric.node.cpu_percent!==null);assert.ok(metric.process);assert.ok(metric.resources.length);assert.equal(metric.tasks.length,24);evidence.metrics=metric;
 const action=async(name:string,reason:string)=>{await page.getByRole('button',{name,exact:true}).click();await page.getByLabel('操作原因').fill(reason);const result=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().includes('/v1/workers/'));await page.getByRole('button',{name:'确认'+name,exact:true}).click();const r=await result;assert.equal(r.status(),200);return WorkerSchema.parse(await r.json());};
 phase='pause';const paused=await action('暂停接单','D2 真实页面暂停验收，完成后恢复');evidence.pause_response=paused;await wait(w=>w.control?.status==='PAUSED');
 const cutoff=paused.control!.changed_at!;
 const assignments=async()=>Number((await pool.query("SELECT count(*) AS n FROM control.worker_plans WHERE workspace_id=$1 AND worker_id=$2 AND queue_kind='OWNED' AND assigned_at>$3::timestamptz",[workspace,worker!.worker_id,cutoff])).rows[0].n);
 assert.equal(await assignments(),0);await page.getByRole('button',{name:'刷新 Worker'}).click();await expect(page.locator('.worker-detail')).toContainText('已暂停接单');
 phase='drain';const draining=await action('排空','D2 等待既有计划与搜索完整结束');evidence.drain_response=draining;
 await wait(w=>w.control?.status==='DRAINED',180000);assert.equal(await assignments(),0);evidence.drained=worker;
 const searchAfter=Number((await pool.query("SELECT count(*) AS n FROM control.query_runs WHERE workspace_id=$1 AND coalesce(worker_id,last_worker_id)=$2 AND claimed_at>$3::timestamptz",[workspace,worker!.worker_id,cutoff])).rows[0].n);assert.equal(searchAfter,0);evidence.new_assignments_while_closed=0;evidence.new_searches_while_closed=0;
 await page.getByRole('button',{name:'刷新 Worker'}).click();await expect(page.locator('.worker-detail')).toContainText('已排空');
 phase='resume';await action('恢复接单','D2 验收完成，恢复正常采集');await wait(w=>w.control?.status==='RUNNING');restored=true;evidence.resumed=worker;
 phase='layout';const layouts=[];for(const [width,height] of [[1920,937],[1586,992],[390,844]] as const){await page.setViewportSize({width,height});await page.locator('.worker-detail .detail-body').evaluate(n=>{n.scrollTop=0;});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBe(0);if(width<=680)await expect.poll(()=>page.locator('.sidebar').evaluate(n=>n.getBoundingClientRect().right)).toBeLessThanOrEqual(0);await page.screenshot({path:dir+'/workers-'+width+'.png',fullPage:true});layouts.push({width,height,horizontal_overflow:0});}evidence.layouts=layouts;
 phase='reader';const readonly=await browser.newPage({viewport:{width:390,height:844},extraHTTPHeaders:{authorization:'Bearer '+reader}});await readonly.goto(origin+'/workers');await expect(readonly.locator('.worker-list tbody tr')).toHaveCount(1);await expect(readonly.getByRole('button',{name:'暂停接单',exact:true})).toBeDisabled();
 const denied=await readonly.request.post(origin+'/api/v1/workers/'+worker!.worker_id+'/pause',{data:{command_id:crypto.randomUUID(),expected_version:worker!.control!.version,reason:'D2 reader 权限验收'}});assert.equal(denied.status(),403);evidence.reader_write_status=403;
 assert.equal(errors.length,0);assert.equal(failed.length,0);writeFileSync(dir+'/browser-evidence.json',JSON.stringify({result:'PASSED',at:new Date().toISOString(),...evidence,page_errors:errors,failed_api_reads:failed},null,2),{mode:0o600});console.log('D2 real pause, full drain, closed admission gates, resume, metrics and phone layout passed');
}catch(e){writeFileSync(dir+'/browser-failure.json',JSON.stringify({phase,error:e instanceof Error?e.name:'UnknownError',...evidence,page_errors:errors,failed_api_reads:failed}),{mode:0o600});console.error('D2 browser verification failed at '+phase);process.exitCode=1;}
finally{
 if(!restored&&worker){try{const w=(await workers()).find(w=>w.worker_id===worker!.worker_id);if(w?.control?.desired!=='RUNNING'&&w?.control){const response=await fetch(origin+'/api/v1/workers/'+w.worker_id+'/resume',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({command_id:crypto.randomUUID(),expected_version:w.control.version,reason:'D2 验收异常后恢复正常接单'}),signal:AbortSignal.timeout(15000)});assert.equal(response.status,200);}}catch{console.error('D2 Worker restoration needs review');process.exitCode=1;}}
 await browser.close();await pool.end();
}
