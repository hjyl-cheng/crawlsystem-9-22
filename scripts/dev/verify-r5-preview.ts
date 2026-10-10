import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import {setTimeout as delay} from 'node:timers/promises';
import {createPool} from '@crawlsystem/store/config';
import {issueToken,loadSigningKey} from '@crawlsystem/http/auth';
import {CONTRACT_VERSION,PlanDetailSchema,PlanSchema,type Principal} from '@crawlsystem/contracts';
import {RawReferenceSchema} from '@crawlsystem/contracts/pipeline';
import {FailureSchema,AnalyticsSchema,StorageSchema} from '@crawlsystem/contracts/analytics';
import {MinioStore} from '../../apps/execution-worker/src/raw-archive.ts';
import {failureEnvelope} from '../../apps/raw-parser/src/failure.ts';
import {r5ClickHouse} from './r5-clickhouse.ts';
const mode=process.argv[2]??'recovery';assert.ok(['recovery','outage','final'].includes(mode));
const kube=(args:string[],input?:string)=>execFileSync('kubectl',args,{encoding:'utf8',input,stdio:['pipe','pipe','pipe'],timeout:180000}).trim();
const pool=createPool(),workspace='m1-main',base=`http://${kube(['-n','control','get','svc','control-api-preview','-o','jsonpath={.spec.clusterIP}'])}:18100`;
const token=await issueToken({subject:'r5-acceptance',workspace_id:workspace,role:'operator'},loadSigningKey(),1800);
async function api(path:string,body?:unknown,auth=token) {
 const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${auth}`,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(35_000)});assert.ok(r.ok,`Acceptance HTTP ${r.status}`);return r.json();
}
async function until<T>(work:()=>Promise<T|undefined>,ms=120000):Promise<T> {const end=Date.now()+ms;for(;;){const value=await work();if(value!==undefined)return value;if(Date.now()>end)throw new Error('Acceptance condition not met');await delay(1000);}}
const file='.runtime/r5/recovery-state.json';let state:any=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};
const save=()=>writeFileSync(file,JSON.stringify(state,null,2),{mode:0o600});
const publish=(ns:string,deployment:string,topic:string,messages:unknown[])=>kube(['-n',ns,'exec','-i',`deployment/${deployment}`,'--','node','/app/ops-tool.mjs'],JSON.stringify({topic,messages}));
try {
 if(mode==='recovery') {
  const replicas=kube(['-n','control','get','deployment','intent-dispatcher','-o','jsonpath={.spec.replicas}']);
  kube(['-n','control','scale','deployment/intent-dispatcher','--replicas=0']);
  try {
   await until(async()=>JSON.parse(kube(['-n','control','get','pods','-l','app.kubernetes.io/name=intent-dispatcher','-o','json'])).items.length===0?true:undefined);
   if(!state.plan_id) {
    const p=PlanSchema.parse(await api('/v1/plans',{request_id:randomUUID(),fixture_id:'channel-basic-v1',required_domains:['ABOUT']}));state.plan_id=p.plan_id;save();
   }
   const detail=PlanDetailSchema.parse(await api(`/v1/plans/${state.plan_id}`)),p=detail.plan;
   const owner={schema_version:CONTRACT_VERSION,workspace_id:workspace,plan_id:p.plan_id,execution_epoch:p.execution_epoch,input_hash:p.input_hash,workflow_id:p.workflow_id};
   if(!state.raw) {
    assert.equal(detail.input.source_mode,'fixture');if(detail.input.source_mode!=='fixture')throw new Error('Wrong test input');
    const at=new Date().toISOString(),body={schema_version:'crawl.unit.v1',owner,channel_id:p.channel_id,step:'ABOUT',unit_id:'channel',captured_at:at,responses:[{endpoint:'local:fixture',method:'LOCAL',status:200,captured_at:at,body:'{}'}],result:detail.input.sample.about},bytes=gzipSync(JSON.stringify(body));
    const data=JSON.parse(kube(['-n','crawler','get','secret','minio-crawl-worker','-o','json'])).data,decode=(key:string)=>Buffer.from(data[key],'base64').toString();
    const storageIp=kube(['-n','storage','get','svc','minio','-o','jsonpath={.spec.clusterIP}']),store=new MinioStore(`http://${storageIp}:9000`,'crawl-raw',decode('access_key'),decode('secret_key'));
    const raw=RawReferenceSchema.parse({schema_version:'crawl.raw.v1',workspace_id:workspace,plan_id:p.plan_id,execution_epoch:1,input_hash:p.input_hash,channel_id:p.channel_id,step:'ABOUT',unit_id:'channel',bucket:'crawl-raw',key:`v1/${workspace}/${p.plan_id}/1/ABOUT/channel.json.gz`,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,captured_at:at});
    await store.put(raw.key,bytes,AbortSignal.timeout(30000),true);state.raw=raw;save();
   }
   if(!state.failure_id) {
    const sink=await issueToken({subject:'r5-acceptance-sink',workspace_id:workspace,role:'sink'},loadSigningKey(),600);
    const manifest={schema_version:'crawl.step.v1',owner,channel_id:p.channel_id,step:'ABOUT',units:[state.raw],completed_at:new Date().toISOString(),bucket:'crawl-raw',key:state.raw.key.replace('channel.json.gz','_manifest.json.gz')};
    const data=JSON.parse(kube(['-n','crawler','get','secret','minio-crawl-worker','-o','json'])).data,decode=(key:string)=>Buffer.from(data[key],'base64').toString();
    const storageIp=kube(['-n','storage','get','svc','minio','-o','jsonpath={.spec.clusterIP}']),store=new MinioStore(`http://${storageIp}:9000`,'crawl-raw',decode('access_key'),decode('secret_key'));
    await store.put(manifest.key,gzipSync(JSON.stringify(manifest)),AbortSignal.timeout(30000),true);
    await api('/v1/pipeline/manifests',manifest,sink);
    const envelope=failureEnvelope('PARSER','crawl.raw',0,'5000000001','INVALID_FACT',3,JSON.stringify(state.raw));envelope.report.report_id='r5-recovery:'+p.plan_id;
    publish('crawler','raw-parser','dlq.parse',[envelope]);
    const row=await until(async()=>{const r=(await pool.query("SELECT failure_id FROM control.failures WHERE workspace_id=$1 AND plan_id=$2 AND code='INVALID_FACT' AND evidence_state='SAVED'",[workspace,p.plan_id])).rows[0];return r?.failure_id;});state.failure_id=row;save();
   }
   if(!state.retry_complete) {
    const f=FailureSchema.parse(await api(`/v1/failures/${state.failure_id}`));assert.equal(f.evidence_state,'SAVED');
    if(!state.retry_command){assert.equal(f.state,'OPEN');assert.equal(f.retryable,true);state.retry_command={command_id:randomUUID(),expected_version:f.version,action:'retry',reason:'R5 验收：重放保留的有效原始对象'};save();}
    const a=await api(`/v1/failures/${f.failure_id}/commands`,state.retry_command),b=await api(`/v1/failures/${f.failure_id}/commands`,state.retry_command);assert.deepEqual(a,b);
    await until(async()=>{const f=FailureSchema.parse(await api(`/v1/failures/${state.failure_id}`)),d=PlanDetailSchema.parse(await api(`/v1/plans/${state.plan_id}`));return f.state==='RESOLVED'&&d.plan.status==='COMPLETED'?true:undefined;});
    const e=await api(`/v1/failures/${f.failure_id}/evidence`);assert.equal(e.available,true);assert.equal(e.sha256,state.raw.sha256);state.retry_complete=true;save();
   }
   if(!state.ignored_failure_id) {
    const envelope=failureEnvelope('SINK','facts.channel',0,'5000000002','PLAN_TERMINAL',3,JSON.stringify({raw:state.raw}));envelope.report.report_id='r5-obsolete:'+p.plan_id;
    publish('ingest','pg-sink','dlq.sink',[envelope]);
    const id=await until(async()=>(await pool.query("SELECT failure_id FROM control.failures WHERE plan_id=$1 AND code='PLAN_TERMINAL'",[state.plan_id])).rows[0]?.failure_id);
    const f=FailureSchema.parse(await api(`/v1/failures/${id}`));assert.equal(f.retryable,false);
    const ignored=await api(`/v1/failures/${id}/commands`,{command_id:randomUUID(),expected_version:f.version,action:'ignore',reason:'R5 验收：计划已完成，旧消息不再重放'});assert.equal(ignored.state,'IGNORED');state.ignored_failure_id=id;save();
   }
   await until(async()=>{const s=StorageSchema.parse(await api('/v1/storage'));return s.outbox.unarchived===0?s:undefined;});
   console.log(JSON.stringify({result:'PASSED',real_dlq_consumed:true,evidence_saved:true,operator_retry_idempotent:true,raw_replayed:true,parser_sink_completed:true,obsolete_message_ignored:true,plan_id:state.plan_id}));
  }finally{kube(['-n','control','scale','deployment/intent-dispatcher',`--replicas=${replicas}`]);}
 }else if(mode==='outage') {
  await until(async()=>{const s=StorageSchema.parse(await api('/v1/storage'));return s.outbox.unarchived===0?true:undefined;});
  const current=JSON.parse(kube(['-n','analytics','get','deployment','crawl-analytics','-o','json'])),old=current.spec.template.spec.containers[0].env.find((e:any)=>e.name==='CLICKHOUSE_URL')?.value;
  try {
   kube(['-n','analytics','set','env','deployment/crawl-analytics','CLICKHOUSE_URL=https://127.0.0.1:1']);
   await until(async()=>{const pods=JSON.parse(kube(['-n','analytics','get','pods','-l','app.kubernetes.io/name=crawl-analytics','-o','json'])).items;return pods.length>0&&pods.every((p:any)=>p.spec.containers[0].env.some((e:any)=>e.name==='CLICKHOUSE_URL'&&e.value==='https://127.0.0.1:1'))?true:undefined;});
   const d=PlanDetailSchema.parse(await api(`/v1/plans/${state.plan_id}`)),worker='r5-outage-worker',auth=await issueToken({subject:worker,workspace_id:workspace,role:'worker'},loadSigningKey(),600);
   state.outage_event_id=randomUUID();await api(`/v1/plans/${state.plan_id}/events`,{event_id:state.outage_event_id,worker_id:worker,execution_epoch:d.plan.execution_epoch,phase:'R5_ARCHIVE_OUTAGE',kind:'PROGRESS',domain:null,message:'Bounded R5 archive transport outage acceptance'},auth);save();
   await delay(5000);const s=StorageSchema.parse(await api('/v1/storage'));assert.ok(s.outbox.unarchived>0);state.outage_retained=s.outbox.unarchived;save();
  }finally{kube(['-n','analytics','set','env','deployment/crawl-analytics',old?`CLICKHOUSE_URL=${old}`:'CLICKHOUSE_URL-']);kube(['-n','analytics','rollout','status','deployment/crawl-analytics','--timeout=120s']);}
  await until(async()=>{const s=StorageSchema.parse(await api('/v1/storage'));return s.outbox.unarchived===0?true:undefined;});
  const ch=r5ClickHouse(),sample=(await pool.query("SELECT event FROM telemetry.outbox WHERE workspace_id=$1 AND event->>'source_mode'='youtube' AND event->>'kind'='FACT' ORDER BY seq LIMIT 1",[workspace])).rows[0]?.event;assert.ok(sample);
  const before=await ch.statistics(workspace,7),published=JSON.parse(publish('analytics','crawl-analytics','ops.events',[sample,sample]).split('\n').at(-1)!);
  await until(async()=>{const output=kube(['-n','analytics','exec','-i','deployment/crawl-analytics','--','node','/app/ops-tool.mjs'],JSON.stringify({operation:'offsets'})),offsets=JSON.parse(output.split('\n').at(-1)!).offsets;
   return published.offsets.every((p:any)=>offsets.some((o:any)=>o.partition===p.partition&&BigInt(o.offset)>=BigInt(p.baseOffset)+2n))?true:undefined;});
  const after=await ch.statistics(workspace,7);assert.deepEqual(after.totals,before.totals);
  state.outage_recovered=true;state.duplicate_preserved=true;save();console.log(JSON.stringify({result:'PASSED',unarchived_retained_during_outage:state.outage_retained,recovered:true,real_kafka_duplicate_count_unchanged:true}));
 }else {
  const before=JSON.parse(readFileSync('.runtime/r5/preservation-before.json','utf8')),ids=(await pool.query('SELECT workspace_id,channel_id,video_id FROM crawl_data.videos ORDER BY 1,2,3')).rows;assert.deepEqual(ids,before.ids);
  const counts=(await pool.query(`SELECT count(*)::int AS videos,count(*) FILTER(WHERE data->'comments_first_page' IS NOT NULL AND data->'comments_first_page'<>'null'::jsonb)::int AS comment_bodies,count(*) FILTER(WHERE data->'comments_ref' IS NOT NULL AND data->'comments_ref'<>'null'::jsonb)::int AS comment_refs FROM crawl_data.videos`)).rows[0];assert.deepEqual(counts,before.counts);
  const analytics=AnalyticsSchema.parse(await api('/v1/analytics?days=7')),storage=StorageSchema.parse(await api('/v1/storage'));assert.equal(storage.outbox.unarchived,0);assert.equal(storage.clickhouse.available,true);
  assert.equal((await pool.query('SELECT max(version) AS version FROM m1.migrations')).rows[0].version,29);
  for(const [ns,kind,name,flag,value] of [['control','deployment','control-api-preview','QUERY_RUNS_ENABLED','false'],['control','deployment','control-api-preview','QUERY_AUTO_ADMIT','false'],['control','deployment','intent-dispatcher','UPDATE_SCHEDULER_ENABLED','false'],['crawler','statefulset','execution-worker','QUERY_RUNNER_SLOTS','0'],['crawler','statefulset','execution-worker','REQUIRED_EGRESS_COUNTRY','']])
   assert.equal(kube(['-n',ns!,'get',kind!,name!,'-o',`jsonpath={.spec.template.spec.containers[0].env[?(@.name=="${flag}")].value}`]),value);
  const privileges=(await pool.query("SELECT has_table_privilege('crawlsystem_control_v3','crawl_data.videos','UPDATE') AS control_fact_write,has_table_privilege('crawlsystem_sink_pg_v3','control.plans','SELECT') AS sink_control_read,has_table_privilege('crawlsystem_sink_pg_v3','control.failures','UPDATE') AS sink_control_write")).rows[0];assert.deepEqual(privileges,{control_fact_write:false,sink_control_read:false,sink_control_write:false});
  const result={result:'PASSED',verified_at:new Date().toISOString(),schema_version:29,counts,preserved_ids:ids.length,analytics,storage,privileges,recovery:{retry_completed:state.retry_complete,ignored_failure:!!state.ignored_failure_id,outage_recovered:state.outage_recovered,duplicate_preserved:state.duplicate_preserved},automatic_search:false,automatic_admission:false,automatic_updates:false,query_runner_slots:0,forced_br_egress:false};
  writeFileSync('.runtime/r5/final-evidence.json',JSON.stringify(result,null,2));console.log(JSON.stringify({result:result.result,schema_version:result.schema_version,counts,unarchived:storage.outbox.unarchived,recovery:result.recovery}));
 }
}finally{await pool.end();}
