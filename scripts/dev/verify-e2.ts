import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {setTimeout} from 'node:timers/promises';
import {chromium,expect} from '@playwright/test';
import {createPool} from '@crawlsystem/store/config';
import {issueToken,loadSigningKey} from '@crawlsystem/http/auth';
import {ChannelImportsSchema} from '@crawlsystem/contracts';
const dir='.runtime/e2',origin='http://127.0.0.1:18103',workspace='m1-main',pool=createPool();
const bootstrap=JSON.parse(readFileSync(dir+'/bootstrap.json','utf8'));
const eligible=bootstrap.failures.filter((r:any)=>r.retry_at && !r.retry_blocked_reason);
const additional=(await pool.query("SELECT channel_id FROM control.channel_imports WHERE workspace_id=$1 AND auto_retry_count>0",[workspace])).rows;
const ids=[...new Set<string>([...eligible.map((r:any)=>r.channel_id),...additional.map(r=>r.channel_id)])];
const key=loadSigningKey(),token=await issueToken({subject:'e2-verification',workspace_id:workspace,role:'operator'},key,600),headers={authorization:'Bearer '+token};
const get=async(path:string)=>{const r=await fetch(origin+'/api'+path,{headers,signal:AbortSignal.timeout(15000)});assert.equal(r.status,200);return r.json();};
const browser=await chromium.launch({headless:true}),errors:string[]=[];let phase='api';
try{
  assert.equal((await pool.query('SELECT max(version)::int n FROM m1.migrations')).rows[0].n,37);
  const imports=ChannelImportsSchema.parse(await get('/v1/channels/imports'));assert.ok(imports.retry_counts);
  const pages=[];
  for(const role of ['reader','worker'] as const){
    const credential=await issueToken({subject:'e2-'+role,workspace_id:workspace,role},key,600);
    const r=await fetch(origin+'/api/v1/channels/imports',{headers:{authorization:'Bearer '+credential},signal:AbortSignal.timeout(15000)});assert.equal(r.status,role==='reader'?200:403);
  }
  const isolated=await issueToken({subject:'e2-absent',workspace_id:'e2-isolated',role:'reader'},key,600);
  const absent=await fetch(origin+'/api/v1/channels/imports',{headers:{authorization:'Bearer '+isolated},signal:AbortSignal.timeout(15000)});
  assert.equal(ChannelImportsSchema.parse(await absent.json()).items.length,0);
  phase='browser';const page=await browser.newPage({extraHTTPHeaders:headers,viewport:{width:1920,height:937}});
  page.on('pageerror',e=>errors.push(e.name));await page.goto(origin+'/channels');await expect(page.locator('.import-queue')).toContainText('等待自动重试');await expect(page.locator('.import-queue')).toContainText('需人工处理');
  for(const width of [1920,390]){await page.setViewportSize({width,height:937});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBe(0);if(width<680)await expect.poll(()=>page.locator('.sidebar').evaluate(n=>n.getBoundingClientRect().right)).toBeLessThanOrEqual(0);await page.screenshot({path:dir+'/channels-'+width+'.png',fullPage:true});pages.push({name:'channels',width,horizontal_overflow:0});}
  // Exercise all labels through read-only browser responses; these are UI fixtures,
  // not injected failures or alterations to any production collection.
  const candidates=await get('/v1/candidates?limit=20&cursor=0');assert.ok(candidates.items.length);
  const sample:{[key:string]:any}={...candidates.items[0],state:'ADMITTED',import_state:'failed',import_retry:{attempts:1,next_at:new Date(Date.now()+300000).toISOString(),blocked_reason:null,last_code:'UNAVAILABLE'}};
  await page.route('**/api/v1/candidates?*',route=>route.fulfill({json:{items:[sample],next_cursor:null}}));
  await page.goto(origin+'/discover/candidates');await expect(page.locator('tbody')).toContainText('等待自动重试');await expect(page.locator('tbody')).toContainText('自动重试 1/3');
  for(const width of [1920,390]){await page.setViewportSize({width,height:937});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBe(0);if(width<680)await expect.poll(()=>page.locator('.sidebar').evaluate(n=>n.getBoundingClientRect().right)).toBeLessThanOrEqual(0);const retryLabel=page.locator('tbody small').filter({hasText:'等待自动重试'});await retryLabel.scrollIntoViewIfNeeded();await expect(retryLabel).toBeVisible();await page.screenshot({path:dir+'/candidate-retry-'+width+'.png',fullPage:true});pages.push({name:'candidate_retry_fixture',width,horizontal_overflow:0});}
  sample.import_retry={...sample.import_retry,attempts:3,next_at:null,blocked_reason:'exhausted'};await page.reload();await expect(page.locator('tbody')).toContainText('次数用尽，需人工处理');
  sample.import_retry={...sample.import_retry,blocked_reason:'cancelled'};await page.reload();await expect(page.locator('tbody')).toContainText('已人工取消，不自动重试');
  const reader=await issueToken({subject:'e2-reader-ui',workspace_id:workspace,role:'reader'},key,600);
  const readonly=await browser.newPage({extraHTTPHeaders:{authorization:'Bearer '+reader}});await readonly.goto(origin+'/channels');await expect(readonly.locator('.import-queue')).toContainText('等待自动重试');assert.equal(await readonly.getByRole('button',{name:'导入频道',exact:true}).count(),0);
  phase='live-retry';assert.ok(ids.length,'an existing real transient failure is required for this acceptance');
  const deadline=Date.now()+240000;let live:any[]=[],lastLog=0;
  while(Date.now()<deadline){
    live=(await pool.query(`SELECT i.channel_id,i.state,i.auto_retry_count,i.retry_at,i.retry_blocked_reason,i.plan_id,p.status,
      p.frozen_input->'discovery_qualification' AS qualification,
      (SELECT count(*)::int FROM control.domains d WHERE d.plan_id=i.plan_id AND d.state='APPLIED') applied_domains,
      (SELECT count(*)::int FROM crawl_data.videos v WHERE v.workspace_id=i.workspace_id AND v.channel_id=i.channel_id) videos
      FROM control.channel_imports i LEFT JOIN control.plans p USING(plan_id) WHERE i.workspace_id=$1 AND i.channel_id=ANY($2::text[]) ORDER BY i.channel_id`,[workspace,ids])).rows;
    writeFileSync(dir+'/live-progress.json',JSON.stringify({at:new Date().toISOString(),live},null,2)+'\n',{mode:0o600});
    if(Date.now()-lastLog>30000){console.log(JSON.stringify({phase,admitted:live.filter(r=>r.auto_retry_count>0).length,completed:live.filter(r=>r.state==='done').length,waiting:live.filter(r=>r.retry_at).length}));lastLog=Date.now();}
    if(live.some(r=>r.auto_retry_count>0 && r.state==='done'))break;
    await setTimeout(5000);
  }
  const recovered=live.find(r=>r.auto_retry_count>0 && r.state==='done');assert.ok(recovered,'a real automatic retry must finish collecting');
  const original=eligible.find((r:any)=>r.channel_id===recovered.channel_id)??(await pool.query(`SELECT channel_id,plan_id FROM control.plans WHERE workspace_id=$1 AND channel_id=$2 AND status='FAILED'
    AND source_revision<(SELECT source_revision FROM control.plans WHERE plan_id=$3) ORDER BY source_revision DESC LIMIT 1`,[workspace,recovered.channel_id,recovered.plan_id])).rows[0];
  assert.ok(original);assert.notEqual(recovered.plan_id,original.plan_id);assert.equal(recovered.status,'COMPLETED');assert.equal(recovered.applied_domains,3);assert.ok(recovered.videos>0);
  const old=(await pool.query("SELECT status,frozen_input->'discovery_qualification' qualification FROM control.plans WHERE plan_id=$1",[original.plan_id])).rows[0];assert.equal(old.status,'FAILED');assert.deepEqual(recovered.qualification,old.qualification);
  const offline=JSON.parse(readFileSync(dir+'/offline-replay.json','utf8'));
  const blocker=(await pool.query(`SELECT p.plan_id,p.status,f.state AS failure_state,f.retry_plan_id,r.status AS retry_status FROM control.plans p
    JOIN control.failures f USING(plan_id) LEFT JOIN control.plans r ON r.plan_id=f.retry_plan_id WHERE f.failure_id=$1`,[offline.failure_id])).rows[0];
  assert.equal(blocker.status,'FAILED');assert.equal(blocker.retry_status,'COMPLETED');assert.equal(blocker.failure_state,'RESOLVED');
  const duplicates=(await pool.query("SELECT channel_id,count(*)::int n FROM control.plans WHERE workspace_id=$1 AND channel_id=ANY($2::text[]) AND status IN ('QUEUED','RUNNING','WAITING') GROUP BY channel_id HAVING count(*)>1",[workspace,ids])).rows;assert.equal(duplicates.length,0);
  const publicPage=await fetch('https://controversy-roughly-kiss-genealogy.trycloudflare.com/channels',{signal:AbortSignal.timeout(30000)});assert.equal(publicPage.status,200);assert.equal(errors.length,0);
  writeFileSync(dir+'/evidence.json',JSON.stringify({result:'PASSED',at:new Date().toISOString(),schema:37,backoff_minutes:[5,15,60],max_auto_retries:3,permissions:true,workspace_isolation:true,pages,ui_retry_labels_verified_with_readonly_fixtures:true,page_errors:errors,public_status:200,original,recovered,live,blocker_recovery:blocker,offline_replay:offline,duplicate_active_plans:0},null,2)+'\n',{mode:0o600});
  console.log('E2 real automatic retry collected About/videos/Agent; permissions, UI and public access passed');
}catch(error){writeFileSync(dir+'/verification-failure.json',JSON.stringify({phase,error:error instanceof Error?error.name:'UnknownError'},null,2)+'\n',{mode:0o600});console.error('E2 verification failed at '+phase);process.exitCode=1;}
finally{await browser.close();await pool.end();}
