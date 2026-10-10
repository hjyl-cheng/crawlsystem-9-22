import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import {createPool} from '@crawlsystem/store/config';
import {queuePublication} from '../../packages/store/src/publication.ts';
import {issueToken,loadSigningKey} from '@crawlsystem/http/auth';
import {ChannelDetailSchema,PlanSchema} from '@crawlsystem/contracts';

const mode=process.argv[2]??'snapshot';assert.ok(['bootstrap','snapshot','verify','recovery-start','recovery-finish'].includes(mode));
const dir='.runtime/c1',workspace='m1-main',pool=createPool();
const businessUrl=readFileSync(`${dir}/business.env`,'utf8').trim().slice('BUSINESS_DATABASE_URL='.length);
assert.equal(new URL(businessUrl).pathname,'/crawlsystem_business_main');
const biz=new Pool({connectionString:businessUrl,max:2,ssl:{ca:readFileSync(process.env.PG_CA_FILE!,'utf8'),rejectUnauthorized:true,servername:process.env.PG_TLS_SERVERNAME}});
const kube=(args:string[])=>execFileSync('kubectl',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:190000}).trim();
const save=(name:string,v:unknown)=>writeFileSync(`${dir}/${name}.json`,JSON.stringify(v,null,2),{mode:0o600});
const load=(name:string)=>JSON.parse(readFileSync(`${dir}/${name}.json`,'utf8'));
const workloads=[['control','deployment','control-api-preview'],['control','deployment','intent-dispatcher'],['crawler','statefulset','execution-worker'],['crawler','deployment','profile-agent'],['crawler','deployment','raw-parser'],['ingest','deployment','pg-sink'],['analytics','deployment','crawl-analytics'],['ingest','deployment','business-sink'],['control','deployment','delivery-receipts']] as const;
function services(){return workloads.map(([namespace,kind,name])=>{const o=JSON.parse(kube(['-n',namespace,'get',kind,name,'-o','json']));return {namespace,name,ready:o.status.readyReplicas??0,desired:o.spec.replicas,images:o.spec.template.spec.containers.map((c:any)=>({name:c.name,image:c.image}))};});}
const token=await issueToken({subject:'c1-acceptance',workspace_id:workspace,role:'operator'},loadSigningKey(),1800);
const base=`http://${kube(['-n','control','get','svc','control-api-preview','-o','jsonpath={.spec.clusterIP}'])}:18100`;
async function api(path:string,body?:unknown){const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});assert.ok(r.ok,`C1 API ${path}: HTTP ${r.status}`);return r.json();}
async function bootstrap(){
 assert.ok(services().every(s=>s.ready===s.desired&&s.desired>0),'Deploy all C1 services before enabling publication');
 const connector=JSON.parse(kube(['-n','kafka','exec','deployment/debezium-connect','--','curl','--silent','--fail','http://127.0.0.1:8083/connectors/c1-delivery/status']));assert.equal(connector.connector.state,'RUNNING');assert.ok(connector.tasks.every((t:any)=>t.state==='RUNNING'));
 if(!existsSync(`${dir}/enabled.json`)){await pool.query('UPDATE delivery.targets SET enabled=true WHERE workspace_id=$1',[workspace]);save('enabled',{at:new Date().toISOString()});}
 const rows=(await pool.query("SELECT c.channel_id,c.latest_plan_id FROM control.channels c WHERE workspace_id=$1 AND management_state IN ('managed','paused') AND NOT EXISTS(SELECT 1 FROM delivery.channel_state s WHERE s.workspace_id=c.workspace_id AND s.channel_id=c.channel_id) ORDER BY channel_id",[workspace])).rows;
 for(const row of rows){const c=await pool.connect();try{await c.query('BEGIN');await queuePublication(c,workspace,row.channel_id,row.latest_plan_id,false,true);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 console.log(JSON.stringify({phase:'enabled-and-bootstrapped',candidates:rows.length}));
}
async function snapshot(){
 const records=(await pool.query('SELECT delivery_id,channel_id,plan_id,revision,status,error_code,domains,attempts,created_at,received_at FROM delivery.records WHERE workspace_id=$1 ORDER BY created_at',[workspace])).rows;
 const projection=(await biz.query("SELECT count(*)::int AS projected_channels FROM result.entity_current")).rows[0];
 const snapshots=(await biz.query("SELECT (SELECT count(*)::int FROM public.channel_snapshots) AS channel_snapshots,(SELECT count(*)::int FROM public.content_snapshots) AS video_snapshots,(SELECT count(*)::int FROM public.channel_profile_facts) AS profile_facts,(SELECT count(*)::int FROM public.creator_search_live) AS searchable_channels")).rows[0];
 const source=(await pool.query("SELECT count(*)::int AS videos,count(*) FILTER(WHERE data->'comments_first_page' IS NOT NULL AND data->'comments_first_page'<>'null'::jsonb)::int AS comment_bodies FROM crawl_data.videos WHERE workspace_id=$1",[workspace])).rows[0];
 const slot=(await pool.query("SELECT slot_name,active,pg_wal_lsn_diff(pg_current_wal_lsn(),confirmed_flush_lsn)::bigint AS retained_bytes FROM pg_replication_slots WHERE slot_name='c1_delivery_slot'")).rows[0];
 const connector=JSON.parse(kube(['-n','kafka','exec','deployment/debezium-connect','--','curl','--silent','--fail','http://127.0.0.1:8083/connectors/c1-delivery/status']));
 const enabled=load('enabled');
 const plans=(await pool.query('SELECT plan_kind,status,count(*)::int AS n FROM control.plans WHERE workspace_id=$1 AND created_at>=$2 GROUP BY 1,2',[workspace,enabled.at])).rows;
 const failures=(await pool.query("SELECT stage,code,state,count(*)::int AS n FROM control.failures WHERE workspace_id=$1 AND first_at>=$2 GROUP BY 1,2,3",[workspace,enabled.at])).rows;
 const result={at:new Date().toISOString(),records,projection,snapshots,source,slot,services:services(),connector:{state:connector.connector.state,tasks:connector.tasks.map((t:any)=>t.state)},summary:await api('/v1/deliveries/summary'),plans,failures};save('latest',result);
 console.log(JSON.stringify({phase:'snapshot',summary:result.summary,projection,snapshots,source,slot,plans,failures}));return result;
}
try {
 if(mode==='bootstrap')await bootstrap();
 else if(mode==='recovery-start'){
  assert.ok(!existsSync(`${dir}/recovery.json`),'Resume recorded recovery instead of creating another update');
  const row=(await pool.query("SELECT r.channel_id FROM delivery.records r JOIN control.channels c USING(workspace_id,channel_id) WHERE r.workspace_id=$1 AND r.status='DELIVERED' AND c.management_state='managed' AND NOT EXISTS(SELECT 1 FROM control.plans p WHERE p.workspace_id=c.workspace_id AND p.channel_id=c.channel_id AND p.status IN ('QUEUED','RUNNING','WAITING')) ORDER BY (SELECT count(*) FROM crawl_data.videos v WHERE v.workspace_id=c.workspace_id AND v.channel_id=c.channel_id),r.created_at LIMIT 1",[workspace])).rows[0];assert.ok(row,'One delivered idle managed channel required');
  kube(['-n','ingest','scale','deployment/business-sink','--replicas=0']);
  try{const channel=ChannelDetailSchema.parse(await api(`/v1/channels/${row.channel_id}`));const plan=PlanSchema.parse(await api(`/v1/channels/${row.channel_id}/update`,{request_id:randomUUID(),expected_version:channel.management.version,domains:['ABOUT','VIDEO']}));save('recovery',{channel_id:row.channel_id,plan_id:plan.plan_id,started_at:new Date().toISOString()});console.log(JSON.stringify({phase:'sink-paused-update-started',plan_id:plan.plan_id}));}
  catch(e){kube(['-n','ingest','scale','deployment/business-sink','--replicas=1']);throw e;}
 }else if(mode==='recovery-finish'){
  const state=load('recovery');
  try{
   for(const end=Date.now()+120000;;){const p=(await pool.query('SELECT status FROM control.plans WHERE plan_id=$1',[state.plan_id])).rows[0];assert.ok(!['FAILED','CANCELLED'].includes(p.status),'Recovery update must complete');if(p.status==='COMPLETED')break;assert.ok(Date.now()<end,'Resume after recorded update completes');await delay(2000);}
   const r=(await pool.query('SELECT delivery_id,status,shard FROM delivery.records WHERE plan_id=$1',[state.plan_id])).rows[0];assert.ok(r);assert.equal(r.status,'PENDING','Real update must queue while business receiver is stopped');
   const command={command_id:randomUUID(),reason:'C1 验收：接收端停机后重发相同定稿版本'};await api(`/v1/deliveries/${r.delivery_id}/retry`,command);await api(`/v1/deliveries/${r.delivery_id}/retry`,command);
   state.delivery_id=r.delivery_id;state.manifest_hash=r.shard.manifest_hash;state.pending_during_outage=true;state.retry_idempotent=true;save('recovery',state);
  }finally{kube(['-n','ingest','scale','deployment/business-sink','--replicas=1']);kube(['-n','ingest','rollout','status','deployment/business-sink','--timeout=180s']);}
  for(const end=Date.now()+60000;;){const r=(await pool.query('SELECT status FROM delivery.records WHERE delivery_id=$1',[state.delivery_id])).rows[0];if(r?.status==='DELIVERED')break;assert.ok(Date.now()<end,'Receipt must recover after receiver restarts');await delay(2000);}
  const revisions=(await biz.query('SELECT receive_count FROM publication.inbox WHERE revision_id=ANY((SELECT revision_ids FROM delivery_transport.messages WHERE delivery_id=$1))',[state.delivery_id])).rows;
  assert.ok(revisions.length&&revisions.every(r=>r.receive_count>=2),'Both original and retry consumed without losing durable revisions');
  state.completed_at=new Date().toISOString();state.recovered=true;state.duplicate_consumed=true;save('recovery',state);console.log(JSON.stringify({phase:'recovered',...state}));
 }else{
  const result=await snapshot();
  if(mode==='verify'){
   assert.ok(result.services.every(s=>s.ready===s.desired&&s.desired>0));assert.equal(result.connector.state,'RUNNING');assert.ok(result.connector.tasks.length&&result.connector.tasks.every((s:string)=>s==='RUNNING'));
   assert.ok(result.slot?.active&&Number(result.slot.retained_bytes)<64*1024*1024);
   assert.ok(result.records.some(r=>r.status==='DELIVERED'));assert.ok(!result.records.some(r=>['FAILED','PENDING'].includes(r.status)));
   const recovery=load('recovery');assert.ok(recovery.recovered&&recovery.duplicate_consumed);assert.ok(result.plans.some(p=>p.plan_kind==='UPDATE'&&p.status==='COMPLETED'));assert.ok(!result.failures.some(f=>['OPEN','RETRYING'].includes(f.state)));
   assert.equal(result.source.comment_bodies,0);
   const before=load('preservation-before').ids as {workspace_id:string;channel_id:string;video_id:string}[];
   const current=(await pool.query('SELECT workspace_id,channel_id,video_id FROM crawl_data.videos')).rows,ids=new Set(current.map(r=>JSON.stringify([r.workspace_id,r.channel_id,r.video_id])));assert.ok(before.every(r=>ids.has(JSON.stringify([r.workspace_id,r.channel_id,r.video_id]))));
   assert.equal((await biz.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname IN ('public','publication','raw_crawler','result')")).rows[0].n,64);
   for(const r of result.records.filter(r=>r.status==='DELIVERED')){
    const batch=(await pool.query('SELECT receipt,version_vector FROM delivery.records WHERE delivery_id=$1',[r.delivery_id])).rows[0];
    const projected=(await biz.query("SELECT i.version_vector FROM publication.projection_batch_item i JOIN publication.projection_batch b USING(batch_id) WHERE i.batch_id=$1 AND i.channel_id=$2 AND b.status='published'",[batch.receipt.business_batch_id,r.channel_id])).rows[0];assert.ok(projected);
    for(const [domain,requested] of Object.entries(batch.version_vector) as [string,any][]){const actual=projected.version_vector[domain];assert.equal(actual.publication_stream_id,requested.publication_stream_id);assert.ok(Number(actual.sequence)>=Number(requested.sequence));if(Number(actual.sequence)===Number(requested.sequence))assert.equal(actual.result_hash,requested.result_hash);}
   }
   const evidence={result:'PASSED',...result,preserved_video_identities:before.length,legacy_tables:64,recovery};save('final-evidence',evidence);console.log(JSON.stringify({result:'PASSED',delivered:result.records.filter(r=>r.status==='DELIVERED').length,preserved_video_identities:before.length,recovery:true}));
  }
 }
}finally{await pool.end();await biz.end();}
