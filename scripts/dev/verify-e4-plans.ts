import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import {createPool} from '@crawlsystem/store/config';
import {PlanSchema,PlanDetailSchema,ChannelDetailSchema} from '@crawlsystem/contracts';
import {PipelineProgressSchema} from '@crawlsystem/contracts/pipeline';
import {dir,workspace,workerId,apiClient,save,load} from './e4-common.ts';

const mode=process.argv[2]??'check';assert.ok(['start','check'].includes(mode));
const pool=createPool(),businessUrl=readFileSync('.runtime/c1/business.env','utf8').trim().slice('BUSINESS_DATABASE_URL='.length);
assert.equal(new URL(businessUrl).pathname,'/crawlsystem_business_main');
const biz=new Pool({connectionString:businessUrl,max:2,ssl:{ca:readFileSync(process.env.PG_CA_FILE!,'utf8'),rejectUnauthorized:true,servername:process.env.PG_TLS_SERVERNAME}});
try{
 const {api}=await apiClient();
 if(mode==='start'){
  const workers=(await api('/v1/workers?limit=100')).items;
  for(const id of ['execution-worker-0',workerId])assert.ok(workers.some((w:any)=>w.worker_id===id&&!w.stale&&w.control.status==='RUNNING'&&w.collector.gateway==='ready'));
  let state;
  if(existsSync(dir+'/plans.json'))state=load('plans');
  else{
   // Recollect two already qualified channels, two videos each. No change to
   // scheduling switches, update policy, automatic admission or global quotas.
   const channels=(await pool.query(`SELECT c.channel_id,count(v.video_id)::int videos FROM control.channels c JOIN crawl_data.videos v USING(workspace_id,channel_id)
    WHERE c.workspace_id=$1 AND c.management_state='managed'
    AND EXISTS(SELECT 1 FROM delivery.records d WHERE d.workspace_id=c.workspace_id AND d.channel_id=c.channel_id AND d.status='DELIVERED')
    AND NOT EXISTS(SELECT 1 FROM control.plans p WHERE p.workspace_id=c.workspace_id AND p.channel_id=c.channel_id AND p.status IN ('QUEUED','RUNNING','WAITING'))
    GROUP BY c.channel_id HAVING count(v.video_id)>=2 ORDER BY count(v.video_id),c.channel_id LIMIT 2`,[workspace])).rows;assert.equal(channels.length,2);
   state={at:new Date().toISOString(),plans:channels.map(c=>({request:{request_id:randomUUID(),source_mode:'youtube',channel_id:c.channel_id,required_domains:['ABOUT','VIDEO','AGENT'],scope:{video_limit:2,comments_per_video:5}},plan_id:null}))};save('plans',state,true);
  }
  for(const item of state.plans){if(item.plan_id)continue;const plan=PlanSchema.parse(await api('/v1/plans',item.request));item.plan_id=plan.plan_id;save('plans',state);}
  console.log(JSON.stringify({phase:'started',plans:state.plans.map((p:any)=>({plan_id:p.plan_id,channel_id:p.request.channel_id}))}));
 }else{
  const state=load('plans'),results:any[]=[];let complete=false;
  for(const end=Date.now()+210000;;){
   results.length=0;
   for(const item of state.plans){
    assert.ok(item.plan_id);const d=PlanDetailSchema.parse(await api('/v1/plans/'+item.plan_id));
    assert.ok(!['FAILED','CANCELLED'].includes(d.plan.status),`Recorded acceptance plan ${d.plan.status}`);
    const assignment=(await pool.query('SELECT worker_id,queue_kind FROM control.worker_plans WHERE plan_id=$1',[item.plan_id])).rows[0];
    const record=(await pool.query('SELECT delivery_id,status,receipt,version_vector FROM delivery.records WHERE plan_id=$1',[item.plan_id])).rows[0];
    let pipeline,durableUnits;
    if(d.plan.status==='COMPLETED'){
     assert.equal(d.video_targets?.length,2);assert.ok(d.domains.every(v=>v.state==='APPLIED'));assert.equal(d.input.source_mode,'youtube');
     pipeline=PipelineProgressSchema.parse(await api('/v1/plans/'+item.plan_id+'/pipeline'));
     assert.equal(pipeline.steps.length,4);assert.ok(pipeline.steps.every(s=>s.state==='APPLIED'&&s.applied===s.expected));
     durableUnits=(await pool.query('SELECT count(*)::int n FROM crawl_data.ingest_units WHERE plan_id=$1',[item.plan_id])).rows[0].n;assert.equal(durableUnits,5);
     const channel=ChannelDetailSchema.parse(await api('/v1/channels/'+d.plan.channel_id));assert.equal(channel.about?.source,'youtubei:channel_about');
     assert.ok(channel.videos.filter(v=>d.video_targets!.includes(v.source_content_id)).length===2);
     assert.equal(assignment?.queue_kind,'OWNED');assert.ok(['execution-worker-0',workerId].includes(assignment.worker_id));
     if(record?.status==='DELIVERED'){
      const projection=(await biz.query(`SELECT i.version_vector FROM publication.projection_batch_item i JOIN publication.projection_batch b USING(batch_id) WHERE i.batch_id=$1 AND i.channel_id=$2 AND b.status='published'`,[record.receipt.business_batch_id,d.plan.channel_id])).rows[0];assert.ok(projection);
      for(const [domain,requested] of Object.entries(record.version_vector) as [string,any][]){const actual=projection.version_vector[domain];assert.equal(actual.publication_stream_id,requested.publication_stream_id);assert.ok(Number(actual.sequence)>=Number(requested.sequence));if(Number(actual.sequence)===Number(requested.sequence))assert.equal(actual.result_hash,requested.result_hash);}
     }
    }
    results.push({plan_id:item.plan_id,channel_id:d.plan.channel_id,worker_id:assignment?.worker_id,status:d.plan.status,domains:d.domains.map(v=>({domain:v.domain,state:v.state})),targets:d.video_targets,receipts:d.receipts.map(r=>r.logical_batch_key),pipeline_steps:pipeline?.steps,durable_units:durableUnits,delivery_id:record?.delivery_id,delivery_status:record?.status});
   }
   if(results.every(r=>r.status==='COMPLETED'&&r.delivery_status==='DELIVERED')){complete=true;break;}
   if(Date.now()>=end)break;
   await delay(5000);
  }
  save('plans-progress',{at:new Date().toISOString(),complete,results});
  if(complete)save('plans-evidence',{result:'PASSED',at:new Date().toISOString(),results});
  console.log(JSON.stringify({phase:complete?'verified':'progress',result:complete?'PASSED':'PENDING',results}));
 }
}catch(error){console.error(JSON.stringify({result:'FAILED',mode,error:error instanceof Error?error.name:'UnknownError',guard:error instanceof assert.AssertionError?error.message.split('\n')[0]:undefined}));process.exitCode=1;}
finally{await pool.end();await biz.end();}
