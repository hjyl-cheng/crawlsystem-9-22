import assert from 'node:assert/strict';
import {createPool} from '@crawlsystem/store/config';
import {issueToken,loadSigningKey} from '@crawlsystem/http/auth';
import {chromium,expect} from '@playwright/test';
import {RawRetentionStatusSchema} from '../../packages/contracts/src/raw-retention.ts';
import {dir,kube,object,save,load,workspace,client} from './raw-retention-common.ts';
const mode=process.argv[2],pool=createPool();
const tool=(input:unknown)=>JSON.parse(kube(['-n','analytics','exec','-i','deployment/crawl-analytics','--','node','/app/raw-retention-tool.mjs'],JSON.stringify(input),60000));
assert.equal(new URL(process.env.DATABASE_URL!).pathname,'/crawlsystem_m1_main_test');
try {
 const {api}=await client();
 if(mode==='preview') {
  const items=await api('/v1/storage/raw-retention/preview',{});assert.ok(items.length>0);
  save('preview',{at:new Date().toISOString(),items});
  const permissions=tool({operation:'permissions'});assert.equal(permissions.denied.length,4);save('permissions',permissions);
  const refs=items.slice(0,10).map((i:any)=>({bucket:'crawl-raw',key:i.key}));
  const before=load('before');for(const s of before.sample) {if(s.parsed)refs.push(s.parsed);if(s.comments)refs.push(s.comments);}
  for(const ref of before.protected_refs)refs.push(ref);
  const checked=tool({operation:'head',refs});save('objects-before',checked);
  assert.ok(checked.refs.some((r:any)=>r.bucket==='crawl-raw'&&r.actual_bytes!==null));
  assert.ok(checked.refs.filter((r:any)=>r.bucket==='crawl-parsed').every((r:any)=>r.actual_bytes===r.bytes));
  console.log(JSON.stringify({candidates:items.length,raw_bytes:items.reduce((n:number,i:any)=>n+(i.expected_bytes??0),0),parsed_objects_checked:checked.refs.filter((r:any)=>r.bucket==='crawl-parsed').length,permission_denials:4}));
 }else if(mode==='batch') {
  const result=tool({operation:'batch',limit:10});assert.equal(result.results.length,10);assert.ok(result.results.every((r:any)=>r.outcome==='DELETED'||r.outcome==='MISSING'));
  const checked=tool({operation:'head',refs:result.items.map((i:any)=>({bucket:'crawl-raw',key:i.key}))});assert.ok(checked.refs.every((r:any)=>r.actual_bytes===null));
  save('first-batch',{at:new Date().toISOString(),...result,confirmed_missing:checked.refs});
  console.log(JSON.stringify({deleted:result.results.filter((r:any)=>r.outcome==='DELETED').length,deleted_bytes:result.results.reduce((n:number,r:any)=>n+r.bytes,0),all_raw_heads_missing:true}));
 }else if(mode==='verify') {
  const before=load('before'),objects=load('objects-before');
  const refs=objects.refs.filter((r:any)=>r.bucket==='crawl-parsed'||before.protected_refs.some((p:any)=>p.key===r.key));
  const checked=tool({operation:'head',refs});assert.deepEqual(checked.refs.map((r:any)=>r.actual_bytes),refs.map((r:any)=>r.actual_bytes));
  const counts=(await pool.query(`SELECT (SELECT count(*)::int FROM crawl_data.channels WHERE workspace_id=$1) channels,
    (SELECT count(*)::int FROM crawl_data.videos WHERE workspace_id=$1) videos,(SELECT count(*)::int FROM crawl_data.ingest_units WHERE workspace_id=$1) units`,[workspace])).rows[0];
  for(const key of ['channels','videos','units'])assert.ok(counts[key]>=before.counts[key]);
  for(const sample of before.sample) {
   const row=(await pool.query('SELECT raw_key,raw_hash,fact_hash FROM crawl_data.ingest_units WHERE workspace_id=$1 AND plan_id=$2 AND execution_epoch=$3 AND step=$4 AND unit_id=$5',[workspace,sample.plan_id,sample.execution_epoch,sample.step,sample.unit_id])).rows[0];
   assert.deepEqual(row,{raw_key:sample.raw_key,raw_hash:sample.raw_hash,fact_hash:sample.fact_hash});
  }
  const plans=(await pool.query(`SELECT plan_id,channel_id,status,finished_at FROM control.plans WHERE workspace_id=$1 AND source_mode='youtube'
    AND status='COMPLETED' AND finished_at>$2 ORDER BY finished_at DESC LIMIT 5`,[workspace,before.at])).rows;assert.ok(plans.length>0,'Actual YouTube collection must complete after rollout baseline');
  const status=RawRetentionStatusSchema.parse(await api('/v1/storage/raw-retention'));assert.ok(status.deleted>=10);assert.equal(status.errors,0);
  const workloads=object(['get','pods','-A']).items.filter((p:any)=>['control-api-preview','crawl-analytics','execution-worker','execution-worker-s3','raw-parser','pg-sink'].includes(p.metadata.labels?.['app.kubernetes.io/name'])&&!p.metadata.deletionTimestamp);
  assert.ok(workloads.every((p:any)=>p.status.containerStatuses?.every((c:any)=>c.ready)));
  const capacity=await api('/v1/storage/capacity');
  const result={result:'PASSED',at:new Date().toISOString(),status,counts,baseline_counts:before.counts,parsed_and_comments_preserved:true,protected_failure_objects_preserved:true,ingest_identities_preserved:true,completed_youtube_plans:plans,capacity,ready_workloads:workloads.map((p:any)=>({namespace:p.metadata.namespace,name:p.metadata.name,restarts:p.status.containerStatuses.map((c:any)=>c.restartCount)}))};
  save('live',result);console.log(JSON.stringify({result:'PASSED',status,counts,completed_youtube_plans:plans.length,raw_metric_bytes:capacity.buckets.find((b:any)=>b.bucket==='crawl-raw').used_bytes}));
 }else if(mode==='browser') {
  const token=await issueToken({subject:'raw-retention-reader',workspace_id:workspace,role:'reader'},loadSigningKey(),900),browser=await chromium.launch({headless:true});
  try {
   const page=await browser.newPage({extraHTTPHeaders:{authorization:'Bearer '+token}}),errors:string[]=[],layouts:any[]=[];page.on('pageerror',e=>errors.push(e.name));
   const origins=['http://127.0.0.1:18103',process.env.RAW_RETENTION_PUBLIC_ORIGIN??'https://controversy-roughly-kiss-genealogy.trycloudflare.com'];
   for(const origin of origins)for(const width of [1920,390]) {
    await page.setViewportSize({width,height:1000});await page.goto(origin+'/storage');
    await expect(page.getByRole('heading',{name:'原始响应清理',exact:true})).toBeVisible();
    await expect(page.getByLabel('原始响应容量',{exact:true})).toContainText('成功完成并入库后保留 1 天');
    await expect(page.getByText('成功完成且全部入库后保留 24 小时',{exact:true})).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);await expect(page.getByText('正在加载…',{exact:true})).toHaveCount(0);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth),0);
    if(origin===origins[0])await page.screenshot({path:`${dir}/storage-${width}.png`,fullPage:true});
    layouts.push({origin,width,horizontal_overflow:0});
   }
   assert.deepEqual(errors,[]);save('browser',{result:'PASSED',layouts,page_errors:errors});console.log(JSON.stringify({result:'PASSED',layouts:layouts.length}));
  }finally {await browser.close();}
 }else throw new Error('Usage: verify-raw-retention preview|batch|verify|browser');
}catch(error) {save('verification-failure',{phase:mode,error:error instanceof Error?error.name:'UnknownError',message:error instanceof Error?error.message:undefined});console.error(JSON.stringify({phase:mode,result:'FAILED',error:error instanceof Error?error.name:'UnknownError'}));process.exitCode=1;}
finally {await pool.end();}
