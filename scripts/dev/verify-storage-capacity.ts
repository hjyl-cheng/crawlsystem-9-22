import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import {createPool} from '@crawlsystem/store/config';
import {issueToken,loadSigningKey} from '@crawlsystem/http/auth';
import {StorageCapacitySchema,type StorageCapacity} from '../../packages/contracts/src/storage-capacity.ts';
import {unknownStorageCapacity} from '../../apps/control-api/src/storage-capacity.ts';
import {dir,workspace,kube,object,save,load,client} from './storage-capacity-common.ts';
const mode=process.argv[2],pool=createPool(),local='http://127.0.0.1:18103';
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined,page:Awaited<ReturnType<NonNullable<typeof browser>['newPage']>>|undefined,phase=mode;
try{
 const {api}=await client();
 if(mode==='browser'){
  const capacity=StorageCapacitySchema.parse(await api('/v1/storage/capacity'));assert.equal(capacity.available,true);
  const reader=await issueToken({subject:'storage-capacity-reader',workspace_id:workspace,role:'reader'},loadSigningKey(),900);
  browser=await chromium.launch({headless:true});page=await browser.newPage({extraHTTPHeaders:{authorization:'Bearer '+reader},viewport:{width:1920,height:1000}});
  const errors:string[]=[],bad:string[]=[],layouts:any[]=[];
  page.on('pageerror',e=>errors.push(e.name));page.on('response',r=>{if(r.url().includes('/api/v1/')&&r.status()>=400&&!r.url().includes('/storage/capacity'))bad.push(new URL(r.url()).pathname+':'+r.status());});
  const panel=()=>page!.locator('.panel').filter({has:page!.getByRole('heading',{name:'MinIO 容量',exact:true})});
  const size=(n:number)=>n>=1024**3?`${(n/1024**3).toFixed(2)} GiB`:`${(n/1024**2).toFixed(2)} MiB`;
  const live=async(origin:string)=>{
   const responsePromise=page!.waitForResponse(r=>r.url().includes('/api/v1/storage/capacity')&&r.status()===200);
   await page!.goto(origin+'/storage');const response=await responsePromise;
   const data=StorageCapacitySchema.parse(await response.json());assert.equal(data.available,true);
   await expect(panel().locator('.storage-bucket')).toHaveCount(3);
   for(const bucket of data.buckets){
    const card=page!.getByLabel(bucket.label+'容量',{exact:true});await expect(card).toContainText(size(bucket.used_bytes!));await expect(card).toContainText(size(bucket.quota_bytes!));await expect(card).toContainText(`配额剩余 ${size(bucket.remaining_bytes!)}`);await expect(card).toContainText('保留规则 '+bucket.retention_days+' 天');
    await expect(card.locator('progress')).toHaveAttribute('value',String(Math.min(100,bucket.used_percent!)));
   }
   await expect(page!.getByRole('heading',{name:'入库与恢复',exact:true})).toBeVisible();await expect(page!.getByRole('heading',{name:'数据保留',exact:true})).toBeVisible();
   await expect.poll(()=>page!.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBe(0);
   return data;
  };
  for(const width of [1920,390]){
   phase='layout:'+width;await page.setViewportSize({width,height:1000});const data=await live(local);await page.screenshot({path:dir+'/storage-capacity-'+width+'.png',fullPage:true});layouts.push({width,horizontal_overflow:0,buckets:data.buckets.length});
  }
  phase='unknown-capacity';await page.route('**/api/v1/storage/capacity',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(unknownStorageCapacity())}),{times:1});await page.goto(local+'/storage');
  await expect(panel().getByText('用量未知',{exact:true})).toHaveCount(3);await expect(panel().locator('progress')).toHaveCount(0);await expect(panel()).toContainText('未知用量不会计为 0');await expect(page.getByRole('heading',{name:'入库与恢复',exact:true})).toBeVisible();
  phase='warning-and-critical';const warning:StorageCapacity=structuredClone(capacity);
  warning.buckets=warning.buckets.map((b,i)=>({...b,used_bytes:Math.round(b.quota_bytes!*(i===0?.7:i===1?.85:0)),remaining_bytes:Math.round(b.quota_bytes!*(i===0?.3:i===1?.15:1)),used_percent:i===0?70:i===1?85:0,state:i===0?'warning':i===1?'critical':'ok'}));
  await page.route('**/api/v1/storage/capacity',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(warning)}),{times:1});await page.goto(local+'/storage');await expect(panel().getByText('容量预警',{exact:true})).toBeVisible();await expect(panel().getByText('容量严重',{exact:true})).toBeVisible();
  phase='capacity-error-recovery';await page.route('**/api/v1/storage/capacity',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'UNAVAILABLE',message:'acceptance',retryable:false,correlation_id:'storage-capacity-acceptance'}})}),{times:1});await page.goto(local+'/storage');await expect(panel().getByRole('alert')).toBeVisible();await expect(page.getByRole('heading',{name:'入库与恢复',exact:true})).toBeVisible();await panel().getByRole('button',{name:'重新查询',exact:true}).click();await expect(panel().locator('.storage-bucket')).toHaveCount(3);await expect(panel().getByRole('alert')).toHaveCount(0);
  phase='public';const publicUrl=readFileSync('/home/ubuntu/workspace/crawlsystem-console/.runtime/console-preview/url','utf8').trim();await live(publicUrl);await page.reload();await expect(panel().locator('.storage-bucket')).toHaveCount(3);
  assert.deepEqual(errors,[]);assert.deepEqual(bad,[]);
  save('browser',{result:'PASSED',at:new Date().toISOString(),layouts,live_values_match_api:true,unknown_not_zero:true,warning_critical_states:true,error_recovery:true,original_pipeline_panels:true,reader:true,public:true,page_errors:errors,api_errors:bad});console.log(JSON.stringify({result:'PASSED',layouts:layouts.length,public:true,unknown_not_zero:true}));
 }else if(mode==='runtime'){
  const before=load('before'),settings=(await pool.query('SELECT version,settings FROM control.runtime_settings WHERE workspace_id=$1',[workspace])).rows[0];assert.deepEqual(settings,before.settings);
  assert.deepEqual((await pool.query('SELECT version,checksum FROM m1.migrations ORDER BY version')).rows,before.migrations);
  const originals=load('video-identities'),ids=new Set((await pool.query('SELECT workspace_id,channel_id,video_id FROM crawl_data.videos')).rows.map(r=>JSON.stringify([r.workspace_id,r.channel_id,r.video_id])));assert.ok(originals.every((r:any)=>ids.has(JSON.stringify([r.workspace_id,r.channel_id,r.video_id]))));
  for(const old of before.active_plans){const row=(await pool.query('SELECT plan_id,input_hash,workflow_id,run_id,deadline_at FROM control.plans WHERE plan_id=$1',[old.plan_id])).rows[0];assert.deepEqual(JSON.parse(JSON.stringify(row)),old);}
  const workloads=object(['get','deployment,statefulset,daemonset','-A']).items;
  for(const old of before.workloads.filter((w:any)=>!(w.namespace==='control'&&w.name==='control-api-preview'))){const w=workloads.find((w:any)=>w.metadata.namespace===old.namespace&&w.metadata.name===old.name);assert.ok(w);assert.equal(createHash('sha256').update(JSON.stringify(w.spec)).digest('hex'),old.spec_hash);}
  const pods=object(['get','pods','-A']).items;for(const old of before.pods.filter((p:any)=>!(p.namespace==='control'&&p.name.startsWith('control-api-preview-')))){const p=pods.find((p:any)=>p.metadata.uid===old.uid);assert.ok(p,'Unrelated Pod preserved: '+old.name);assert.deepEqual(p.status.containerStatuses?.map((c:any)=>({name:c.name,n:c.restartCount})),old.restarts);}
  const workers=(await api('/v1/workers?limit=100')).items;assert.equal(workers.length,2);assert.ok(workers.every((w:any)=>!w.stale&&w.control.status==='RUNNING'&&w.collector.gateway==='ready'));
  const delivery=await api('/v1/deliveries/summary');assert.equal(delivery.failed,0);
  const cdc=JSON.parse(kube(['-n','kafka','exec','deployment/debezium-connect','--','curl','--silent','--fail','http://127.0.0.1:8083/connectors/c1-delivery/status']));assert.equal(cdc.connector.state,'RUNNING');assert.ok(cdc.tasks.every((t:any)=>t.state==='RUNNING'));
  const tunnel=Number(execFileSync('systemctl',['--user','show','console-preview-tunnel','--property=MainPID','--value'],{encoding:'utf8'}).trim());assert.equal(tunnel,1882);
  const capacity=StorageCapacitySchema.parse(await api('/v1/storage/capacity'));assert.equal(capacity.available,true);
  const completed=(await pool.query("SELECT a.worker_id,count(*)::int completed FROM control.worker_plans a JOIN control.plans p USING(plan_id) WHERE p.workspace_id=$1 AND p.source_mode='youtube' AND p.status='COMPLETED' AND p.finished_at >= $2 GROUP BY 1",[workspace,before.at])).rows;
  save('runtime-after',{result:'PASSED',at:new Date().toISOString(),schema:before.migrations.length,settings_version:settings.version,preserved_video_identities:originals.length,current_video_identities:ids.size,active_plan_count:before.active_plans.length,unrelated_specs_pods_restarts_preserved:true,active_plan_identities_preserved:true,workers:workers.map((w:any)=>({worker_id:w.worker_id,status:w.control.status})),completed_since_baseline:completed,delivery,cdc:'RUNNING',tunnel_pid:tunnel,capacity});console.log(JSON.stringify({result:'PASSED',delivery,preserved_video_identities:originals.length,current_video_identities:ids.size}));
 }else throw new Error('Usage: verify-storage-capacity browser|runtime');
}catch(error){if(page)await page.screenshot({path:dir+'/browser-failure.png',fullPage:true}).catch(()=>{});save('failure',{phase,error:error instanceof Error?error.name:'UnknownError',message:error instanceof Error?error.message:undefined});console.error(JSON.stringify({result:'FAILED',phase,error:error instanceof Error?error.name:'UnknownError'}));process.exitCode=1;}
finally{await browser?.close();await pool.end();}
