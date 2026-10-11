import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Pool} from 'pg';
import {createPool} from '@crawlsystem/store/config';
import {workspace,workerId,setName,object,kube,apiClient,save,load} from './e4-common.ts';

const mode=process.argv[2]??'after';assert.ok(['before','after','progress'].includes(mode));
const pool=createPool(),businessUrl=readFileSync('.runtime/c1/business.env','utf8').trim().slice('BUSINESS_DATABASE_URL='.length);
assert.equal(new URL(businessUrl).pathname,'/crawlsystem_business_main');
const biz=new Pool({connectionString:businessUrl,max:2,ssl:{ca:readFileSync(process.env.PG_CA_FILE!,'utf8'),rejectUnauthorized:true,servername:process.env.PG_TLS_SERVERNAME}});
try{
 const {api}=await apiClient();
 const settings=(await pool.query('SELECT version,settings FROM control.runtime_settings WHERE workspace_id=$1',[workspace])).rows[0];
 const migrations=(await pool.query('SELECT version,checksum FROM m1.migrations ORDER BY version')).rows;
 const pods=object(['get','pods','-A']).items.filter((p:any)=>!p.metadata.deletionTimestamp).map((p:any)=>({namespace:p.metadata.namespace,name:p.metadata.name,node:p.spec.nodeName,uid:p.metadata.uid,phase:p.status.phase,containers:(p.status.containerStatuses??[]).map((c:any)=>({name:c.name,image:c.image,ready:c.ready,restarts:c.restartCount}))}));
 const workloads=object(['get','deployment,statefulset,daemonset','-A']).items.filter((w:any)=>w.metadata.name!==setName).map((w:any)=>({namespace:w.metadata.namespace,name:w.metadata.name,kind:w.kind,spec_hash:createHash('sha256').update(JSON.stringify(w.spec)).digest('hex')})).sort((a:any,b:any)=>(a.namespace+'/'+a.name).localeCompare(b.namespace+'/'+b.name));
 const workers=(await api('/v1/workers?limit=100')).items,delivery=await api('/v1/deliveries/summary');
 const source=(await pool.query(`SELECT count(*)::int videos,count(*) FILTER(WHERE data->'comments_first_page' IS NOT NULL AND data->'comments_first_page'<>'null'::jsonb)::int comment_bodies FROM crawl_data.videos WHERE workspace_id=$1`,[workspace])).rows[0];assert.equal(source.comment_bodies,0);
 const business=(await biz.query(`SELECT (SELECT count(*)::int FROM pg_tables WHERE schemaname IN ('public','publication','raw_crawler','result')) legacy_tables,(SELECT count(*)::int FROM public.channel_snapshots) channel_snapshots,(SELECT count(*)::int FROM public.content_snapshots) video_snapshots`)).rows[0];assert.equal(business.legacy_tables,64);
 const connector=JSON.parse(kube(['-n','kafka','exec','deployment/debezium-connect','--','curl','--silent','--fail','http://127.0.0.1:8083/connectors/c1-delivery/status']));assert.equal(connector.connector.state,'RUNNING');assert.ok(connector.tasks.every((t:any)=>t.state==='RUNNING'));
 const slot=(await pool.query("SELECT active FROM pg_replication_slots WHERE slot_name='c1_delivery_slot'")).rows[0];assert.equal(slot.active,true);
 const completed=(await pool.query(`SELECT a.worker_id,p.plan_kind,p.status,count(*)::int n,max(p.finished_at) latest_finished_at FROM control.worker_plans a JOIN control.plans p USING(plan_id) WHERE p.workspace_id=$1 AND p.finished_at>=$2 GROUP BY 1,2,3 ORDER BY 1,2,3`,[workspace,mode==='before'?new Date().toISOString():load('runtime-before').at])).rows;
 const searches=(await pool.query(`SELECT coalesce(worker_id,last_worker_id) worker_id,state,count(*)::int n FROM control.query_runs WHERE workspace_id=$1 AND started_at>=$2 GROUP BY 1,2 ORDER BY 1,2`,[workspace,mode==='before'?new Date().toISOString():load('runtime-before').at])).rows;
 const proxies=(await pool.query(`SELECT p.server_id,o.state,count(*)::int n FROM control.proxies p LEFT JOIN control.proxy_observations o ON o.workspace_id=p.workspace_id AND o.proxy_id=p.proxy_id AND o.server_id=p.server_id AND o.generation=p.generation AND o.reported_at>clock_timestamp()-interval '90 seconds' WHERE p.workspace_id=$1 AND p.enabled GROUP BY 1,2 ORDER BY 1,2`,[workspace])).rows;
 const snapshot={at:new Date().toISOString(),settings,migrations,workloads,pods,workers,delivery,source,business,slot,connector:{state:connector.connector.state,tasks:connector.tasks.map((t:any)=>t.state)},completed,searches,proxies};
 if(mode==='before'){
  const ids=(await pool.query('SELECT workspace_id,channel_id,video_id FROM crawl_data.videos ORDER BY 1,2,3')).rows;save('video-identities',ids,true);
  const active=(await pool.query(`SELECT plan_id,input_hash,workflow_id,run_id,deadline_at,execution_epoch FROM control.plans WHERE workspace_id=$1 AND status IN ('QUEUED','RUNNING','WAITING')`,[workspace])).rows;save('active-plans',active,true);
  save('runtime-before',snapshot,true);
 }else if(mode==='after'){
  const before=load('runtime-before');assert.deepEqual(settings,before.settings);assert.deepEqual(migrations,before.migrations);assert.deepEqual(workloads,before.workloads);
  for(const old of before.pods){const current=pods.find((p:any)=>p.uid===old.uid);assert.ok(current,`Original Pod ${old.name} preserved`);assert.deepEqual(current,old);}
  for(const id of ['execution-worker-0',workerId]){const w=workers.find((w:any)=>w.worker_id===id);assert.ok(w&&!w.stale&&w.control.status==='RUNNING');assert.equal(w.collector.gateway,'ready');assert.equal(w.server_id,id===workerId?'s3':'s2');assert.ok(proxies.some((p:any)=>p.server_id===w.server_id&&p.state==='healthy'&&p.n>0));assert.ok(completed.some((p:any)=>p.worker_id===id&&p.status==='COMPLETED'),'Both Workers must complete real plans');}
  assert.equal(object(['-n','crawler','get','statefulset',setName]).status.readyReplicas,1);
  const second=pods.find((p:any)=>p.name===workerId);assert.ok(second&&second.phase==='Running'&&second.containers.every((c:any)=>c.ready&&c.restarts===0));
  assert.deepEqual(second.containers.map((c:any)=>({name:c.name,image:c.image})),pods.find((p:any)=>p.name==='execution-worker-0')!.containers.map((c:any)=>({name:c.name,image:c.image})));
  const ids=new Set((await pool.query('SELECT workspace_id,channel_id,video_id FROM crawl_data.videos')).rows.map(r=>JSON.stringify([r.workspace_id,r.channel_id,r.video_id])));const oldIds=load('video-identities');assert.ok(oldIds.every((r:any)=>ids.has(JSON.stringify([r.workspace_id,r.channel_id,r.video_id]))));
  for(const p of load('active-plans')){const current=(await pool.query('SELECT plan_id,input_hash,workflow_id,run_id,deadline_at,execution_epoch FROM control.plans WHERE plan_id=$1',[p.plan_id])).rows[0];assert.deepEqual(JSON.parse(JSON.stringify(current)),p);}
  assert.ok(source.videos>=before.source.videos);assert.ok(delivery.delivered>=before.delivery.delivered);assert.equal(delivery.failed,0);assert.equal(delivery.pending,0);
  save('runtime-after',{result:'PASSED',...snapshot,preserved_video_identities:oldIds.length});
 }else save('runtime-progress',snapshot);
 console.log(JSON.stringify({phase:mode,result:mode==='after'?'PASSED':'SNAPSHOT',at:snapshot.at,workers:workers.map((w:any)=>({worker_id:w.worker_id,server_id:w.server_id,status:w.control?.status,capacity:w.capacity})),source,delivery,business,completed,searches,proxies}));
}catch(error){console.error(JSON.stringify({result:'FAILED',mode,error:error instanceof Error?error.name:'UnknownError',guard:error instanceof assert.AssertionError?error.message.split('\n')[0]:undefined}));process.exitCode=1;}
finally{await pool.end();await biz.end();}
