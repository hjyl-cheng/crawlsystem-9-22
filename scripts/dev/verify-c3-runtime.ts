import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {Pool} from 'pg';
import {createPool} from '@crawlsystem/store/config';
import {issueToken,loadSigningKey} from '@crawlsystem/http/auth';

const mode=process.argv[2]??'after';assert.ok(['before','after'].includes(mode));
const dir='.runtime/c3',workspace='m1-main';mkdirSync(dir,{recursive:true,mode:0o700});
const pool=createPool();
const businessUrl=readFileSync('.runtime/c1/business.env','utf8').trim().slice('BUSINESS_DATABASE_URL='.length);
assert.equal(new URL(businessUrl).pathname,'/crawlsystem_business_main');
const biz=new Pool({connectionString:businessUrl,max:2,ssl:{ca:readFileSync(process.env.PG_CA_FILE!,'utf8'),rejectUnauthorized:true,servername:process.env.PG_TLS_SERVERNAME}});
const kube=(args:string[])=>JSON.parse(execFileSync('kubectl',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000}));
const workloads=[['control','deployment','control-api-preview'],['control','deployment','intent-dispatcher'],['crawler','statefulset','execution-worker'],['crawler','deployment','profile-agent'],['crawler','deployment','raw-parser'],['ingest','deployment','pg-sink'],['analytics','deployment','crawl-analytics'],['ingest','deployment','business-sink'],['control','deployment','delivery-receipts']] as const;
try{
 const token=await issueToken({subject:'c3-runtime',workspace_id:workspace,role:'operator'},loadSigningKey(),300);
 const get=async(path:string)=>{const r=await fetch('http://127.0.0.1:18103/api'+path,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)});assert.equal(r.status,200,path);return r.json();};
 const [queries,updates,delivery]=await Promise.all([get('/v1/queries/summary'),get('/v1/updates/summary'),get('/v1/deliveries/summary')]);
 assert.equal(queries.runs.enabled,true);assert.equal(updates.limits.enabled,true);assert.equal(updates.limits.daily_plan_limit,100);assert.equal(delivery.enabled,true);
 const services=workloads.map(([namespace,kind,name])=>{const o=kube(['-n',namespace,'get',kind,name,'-o','json']);return {namespace,name,ready:o.status.readyReplicas??0,desired:o.spec.replicas,images:o.spec.template.spec.containers.map((c:any)=>({name:c.name,image:c.image})),automatic:Object.fromEntries(o.spec.template.spec.containers.flatMap((c:any)=>(c.env??[]).filter((e:any)=>['QUERY_RUNS_ENABLED','QUERY_AUTO_ADMIT','UPDATE_SCHEDULER_ENABLED'].includes(e.name)).map((e:any)=>[e.name,e.value])))};});
 assert.ok(services.every(s=>s.ready===s.desired&&s.desired>0));
 for(const service of services.filter(s=>['control-api-preview','intent-dispatcher'].includes(s.name)))assert.equal(service.automatic.QUERY_AUTO_ADMIT,'true');
 const names=[...workloads.map(w=>w[2]),'proxy-manager'];
 const pods=kube(['get','pods','-A','-l',`app.kubernetes.io/name in (${names.join(',')})`,'-o','json']).items.filter((p:any)=>!p.metadata.deletionTimestamp).map((p:any)=>({namespace:p.metadata.namespace,name:p.metadata.name,uid:p.metadata.uid,phase:p.status.phase,containers:(p.status.containerStatuses??[]).map((c:any)=>({name:c.name,ready:c.ready,restarts:c.restartCount,last_exit:c.lastState?.terminated?.reason??null}))}));
 assert.ok(pods.every((p:any)=>p.phase==='Running'&&p.containers.length&&p.containers.every((c:any)=>c.ready)));
 const connector=kube(['-n','kafka','exec','deployment/debezium-connect','--','curl','--silent','--fail','http://127.0.0.1:8083/connectors/c1-delivery/status']);assert.equal(connector.connector.state,'RUNNING');assert.ok(connector.tasks.every((t:any)=>t.state==='RUNNING'));
 const source=(await pool.query("SELECT count(*)::int videos,count(*) FILTER(WHERE data->'comments_first_page' IS NOT NULL AND data->'comments_first_page'<>'null'::jsonb)::int comment_bodies FROM crawl_data.videos WHERE workspace_id=$1",[workspace])).rows[0];assert.equal(source.comment_bodies,0);
 const plans=(await pool.query('SELECT plan_kind,status,count(*)::int n,max(finished_at) latest_finished_at FROM control.plans WHERE workspace_id=$1 GROUP BY 1,2 ORDER BY 1,2',[workspace])).rows;
 const slot=(await pool.query("SELECT active,pg_wal_lsn_diff(pg_current_wal_lsn(),confirmed_flush_lsn)::bigint retained_bytes FROM pg_replication_slots WHERE slot_name='c1_delivery_slot'")).rows[0];assert.ok(slot.active);assert.ok(Number(slot.retained_bytes)<64*1024*1024);
 const business=(await biz.query("SELECT (SELECT count(*)::int FROM pg_tables WHERE schemaname IN ('public','publication','raw_crawler','result')) legacy_tables,(SELECT count(*)::int FROM public.creator_search_live) searchable_channels,(SELECT count(*)::int FROM public.channel_snapshots) channel_snapshots,(SELECT count(*)::int FROM public.content_snapshots) video_snapshots")).rows[0];assert.equal(business.legacy_tables,64);
 if(mode==='after'){
  const before=JSON.parse(readFileSync(`${dir}/runtime-before.json`,'utf8'));
  for(const service of services.filter(s=>s.name!=='control-api-preview'))assert.deepEqual(service.images,before.services.find((s:any)=>s.name===service.name).images);
  for(const pod of pods.filter((p:any)=>!p.name.startsWith('control-api-preview-'))){const prior=before.pods.find((p:any)=>p.uid===pod.uid);assert.ok(prior,'Existing collection and delivery pods must remain in place');assert.deepEqual(pod.containers,prior.containers);}
  assert.ok(source.videos>=before.source.videos);assert.ok(delivery.delivered>=before.delivery.delivered);
 }
 const result={result:'PASSED',at:new Date().toISOString(),mode,automatic:{search:queries.runs.enabled,admission:true,updates:updates.limits.enabled,daily_update_limit:updates.limits.daily_plan_limit},delivery,services,pods,source,plans,slot,business,connector:{state:connector.connector.state,tasks:connector.tasks.map((t:any)=>t.state)}};
 writeFileSync(`${dir}/runtime-${mode}.json`,JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(result));
}catch(error){console.error('C3 runtime verification failed:',error instanceof Error?error.name:'UnknownError');process.exitCode=1;}
finally{await pool.end();await biz.end();}
