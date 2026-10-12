import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import {createPool} from '@crawlsystem/store/config';
import {PlanDetailSchema} from '@crawlsystem/contracts';
import {dir,workspace,workerIds,client,save,load,kube,object} from './finish-common.ts';
const mode=process.argv[2],pool=createPool(),url=readFileSync('.runtime/c1/business.env','utf8').trim().slice('BUSINESS_DATABASE_URL='.length);
assert.equal(new URL(url).pathname,'/crawlsystem_business_main');
const biz=new Pool({connectionString:url,max:2,ssl:{ca:readFileSync(process.env.PG_CA_FILE!,'utf8'),rejectUnauthorized:true,servername:process.env.PG_TLS_SERVERNAME}});
try{
 const {api}=await client();
 if(mode==='start'){
  if(!existsSync(dir+'/plans.json')){
   const rows=(await pool.query(`SELECT c.channel_id,count(v.video_id)::int videos FROM control.channels c JOIN crawl_data.videos v USING(workspace_id,channel_id)
    WHERE c.workspace_id=$1 AND c.management_state='managed' AND EXISTS(SELECT 1 FROM delivery.records d WHERE d.workspace_id=c.workspace_id AND d.channel_id=c.channel_id AND d.status='DELIVERED')
    AND NOT EXISTS(SELECT 1 FROM control.plans p WHERE p.workspace_id=c.workspace_id AND p.channel_id=c.channel_id AND p.status IN ('QUEUED','RUNNING','WAITING'))
    GROUP BY c.channel_id HAVING count(v.video_id)>=2 ORDER BY count(v.video_id),c.channel_id LIMIT 2`,[workspace])).rows;assert.equal(rows.length,2);
   save('plans',{at:new Date().toISOString(),items:rows.map(r=>({request:{request_id:randomUUID(),source_mode:'youtube',channel_id:r.channel_id,required_domains:['ABOUT','VIDEO','AGENT'],scope:{video_limit:2,comments_per_video:5}},plan_id:null}))},true);
  }
  const state=load('plans');for(const item of state.items){if(item.plan_id)continue;item.plan_id=(await api('/v1/plans',item.request)).plan_id;save('plans',state);}
  console.log(JSON.stringify({plans:state.items.map((i:any)=>i.plan_id)}));
 }else if(mode==='plans'){
  const state=load('plans');let results:any[]=[];
  for(const end=Date.now()+210000;;){results=[];
   for(const item of state.items){
    const d=PlanDetailSchema.parse(await api('/v1/plans/'+item.plan_id));assert.ok(!['FAILED','CANCELLED'].includes(d.plan.status),'Acceptance plan failed');
    const delivery=(await pool.query('SELECT delivery_id,status,receipt,version_vector FROM delivery.records WHERE plan_id=$1',[item.plan_id])).rows[0];
    const assignment=(await pool.query('SELECT worker_id FROM control.worker_plans WHERE plan_id=$1',[item.plan_id])).rows[0];
    if(d.plan.status==='COMPLETED'){
     assert.equal(d.video_targets?.length,2);assert.ok(d.domains.every(v=>v.state==='APPLIED'));assert.ok(workerIds.includes(assignment?.worker_id));
     const progress=await api('/v1/plans/'+item.plan_id+'/pipeline');assert.equal(progress.steps.length,4);assert.ok(progress.steps.every((s:any)=>s.state==='APPLIED'&&s.applied===s.expected));
     assert.equal((await pool.query('SELECT count(*)::int n FROM crawl_data.ingest_units WHERE plan_id=$1',[item.plan_id])).rows[0].n,5);
     if(delivery?.status==='DELIVERED'){
      const p=(await biz.query("SELECT i.version_vector FROM publication.projection_batch_item i JOIN publication.projection_batch b USING(batch_id) WHERE i.batch_id=$1 AND i.channel_id=$2 AND b.status='published'",[delivery.receipt.business_batch_id,d.plan.channel_id])).rows[0];assert.ok(p);
      for(const [domain,wanted]of Object.entries(delivery.version_vector) as [string,any][]){const actual=p.version_vector[domain];assert.equal(actual.publication_stream_id,wanted.publication_stream_id);assert.ok(Number(actual.sequence)>=Number(wanted.sequence));if(Number(actual.sequence)===Number(wanted.sequence))assert.equal(actual.result_hash,wanted.result_hash);}
     }
    }
    results.push({plan_id:item.plan_id,channel_id:d.plan.channel_id,worker_id:assignment?.worker_id,status:d.plan.status,delivery_id:delivery?.delivery_id,delivery_status:delivery?.status,domains:d.domains.map(v=>({domain:v.domain,state:v.state})),targets:d.video_targets});
   }
   if(results.every(r=>r.status==='COMPLETED'&&r.delivery_status==='DELIVERED'))break;
   if(Date.now()>=end){save('plans-progress',{results});throw new Error('Real collection acceptance pending');}await delay(3000);
  }
  save('plans-evidence',{result:'PASSED',at:new Date().toISOString(),results});console.log(JSON.stringify({result:'PASSED',results}));
 }else if(mode==='runtime'){
  const before=load('before'),settings=(await pool.query('SELECT version,settings FROM control.runtime_settings WHERE workspace_id=$1',[workspace])).rows[0],migrations=(await pool.query('SELECT version,checksum FROM m1.migrations ORDER BY version')).rows;
  assert.deepEqual(settings,before.settings);assert.deepEqual(migrations.slice(0,before.migrations.length),before.migrations);assert.equal(migrations.length,39);
  const identities=new Set((await pool.query('SELECT workspace_id,channel_id,video_id FROM crawl_data.videos')).rows.map(r=>JSON.stringify([r.workspace_id,r.channel_id,r.video_id]))),original=load('video-identities');assert.ok(original.every((r:any)=>identities.has(JSON.stringify([r.workspace_id,r.channel_id,r.video_id]))));
  for(const old of before.active_plans){const row=(await pool.query('SELECT plan_id,input_hash,workflow_id,run_id,deadline_at FROM control.plans WHERE plan_id=$1',[old.plan_id])).rows[0];assert.deepEqual(JSON.parse(JSON.stringify(row)),old);}
  const allowed=['control-api-preview','raw-parser','pg-sink','execution-worker','execution-worker-s3'];
  const workloads=object(['get','deployment,statefulset,daemonset','-A']).items;
  for(const old of before.workloads.filter((w:any)=>!allowed.includes(w.name))){const w=workloads.find((w:any)=>w.metadata.namespace===old.namespace&&w.metadata.name===old.name);assert.ok(w);assert.equal(createHash('sha256').update(JSON.stringify(w.spec)).digest('hex'),old.spec_hash,'Unrelated workload changed: '+old.name);}
  const pods=object(['get','pods','-A']).items;
  for(const old of before.pods.filter((p:any)=>!allowed.some(name=>p.name===name+'-0'||p.name.startsWith(name+'-')))){const p=pods.find((p:any)=>p.metadata.uid===old.uid);assert.ok(p,'Unrelated Pod preserved: '+old.name);assert.deepEqual(p.status.containerStatuses?.map((c:any)=>({name:c.name,n:c.restartCount})),old.restarts);}
  const workers=(await api('/v1/workers?limit=100')).items;for(const id of workerIds){const w=workers.find((w:any)=>w.worker_id===id);assert.ok(w&&!w.stale&&w.control.status==='RUNNING'&&w.collector.gateway==='ready');}
  const delivery=await api('/v1/deliveries/summary'),business=(await biz.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname IN ('public','publication','raw_crawler','result')")).rows[0];assert.equal(business.n,64);assert.equal(delivery.failed,0);
  assert.equal((await pool.query("SELECT count(*)::int n FROM crawl_data.videos WHERE data->'comments_first_page' IS NOT NULL AND data->'comments_first_page'<>'null'::jsonb")).rows[0].n,0);
  const cdc=JSON.parse(kube(['-n','kafka','exec','deployment/debezium-connect','--','curl','--silent','--fail','http://127.0.0.1:8083/connectors/c1-delivery/status']));assert.equal(cdc.connector.state,'RUNNING');assert.ok(cdc.tasks.every((t:any)=>t.state==='RUNNING'));
  const rules=JSON.parse(kube(['-n','monitoring','exec','deployment/prometheus','--','wget','-qO-','http://127.0.0.1:9090/api/v1/rules'])).data.groups.find((g:any)=>g.name==='crawl-business');assert.equal(rules.rules.length,8);assert.ok(rules.rules.every((r:any)=>r.health==='ok'));
  const metrics=JSON.parse(kube(['-n','monitoring','exec','deployment/prometheus','--','wget','-qO-','http://127.0.0.1:9090/api/v1/query?query=m1_delivery_failed']));assert.equal(metrics.data.result.length,2);assert.ok(metrics.data.result.every((m:any)=>Number.isFinite(Number(m.value[1]))));
  const bridge=kube(['-n','monitoring','exec','deployment/alert-dingtalk','--','python3','-c',"import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8080/health',timeout=5).status)"]);assert.equal(bridge,'200');
  const tunnel=Number((await import('node:child_process')).execFileSync('systemctl',['--user','show','console-preview-tunnel','--property=MainPID','--value'],{encoding:'utf8'}).trim());assert.equal(tunnel,1882);
  const completed=(await pool.query("SELECT a.worker_id,count(*)::int n FROM control.worker_plans a JOIN control.plans p USING(plan_id) WHERE p.workspace_id=$1 AND p.finished_at>=$2 AND p.status='COMPLETED' GROUP BY 1",[workspace,before.at])).rows;
  save('runtime-after',{result:'PASSED',at:new Date().toISOString(),schema:39,settings_version:settings.version,preserved_video_identities:original.length,current_video_identities:identities.size,old_business_tables:64,workers:workers.map((w:any)=>({worker_id:w.worker_id,server_id:w.server_id,status:w.control.status})),delivery,completed,business_alerts:rules.rules.map((r:any)=>({name:r.name,health:r.health,state:r.state})),dingtalk_health:200,tunnel_pid:tunnel});
  console.log(JSON.stringify({result:'PASSED',preserved_video_identities:original.length,delivery,completed,alerts:rules.rules.map((r:any)=>({name:r.name,state:r.state}))}));
 }else throw new Error('Usage: verify-completion start|plans|runtime');
}catch(error){console.error(JSON.stringify({result:'FAILED',phase:mode,error:error instanceof Error?error.name:'UnknownError',guard:error instanceof assert.AssertionError?error.message.split('\n')[0]:undefined}));process.exitCode=1;}
finally{await pool.end();await biz.end();}
