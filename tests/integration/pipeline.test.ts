import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Store } from '@crawlsystem/store';
import { createPool } from '@crawlsystem/store/config';
import { CONTRACT_VERSION, type Principal,type Domain,type Submission,type Plan,type VideoFacts } from '@crawlsystem/contracts';
import { fixtureChannel,fixtureVideo } from '@crawlsystem/contracts/fixtures';
import { stableSubmissionId,submissionHash,contentHash } from '@crawlsystem/contracts/hash';
import { PipelineFactSchema, type PipelineFact, type RawReference } from '@crawlsystem/contracts/pipeline';
import { PgSink } from '../../apps/pg-sink/src/sink.ts';
import { prepareDatabase } from './database-ready.ts';

const pool=createPool(),store=new Store(pool,undefined,undefined,{enabled:true,loadComments:async()=>structuredClone(fixtureVideo.comments_first_page!)}),sink=new PgSink(pool);
before(async()=>{await prepareDatabase(pool);});after(async()=>{await pool.end();});
function submission(plan:Plan,key:string,payload:unknown):Submission {
  const body={schema_version:CONTRACT_VERSION,plan_id:plan.plan_id,execution_epoch:plan.execution_epoch,input_hash:plan.input_hash,
    submission_id:stableSubmissionId(plan.plan_id,plan.execution_epoch,'VIDEO',key),logical_batch_key:key,domain:'VIDEO' as const,domain_complete:false,payload};
  return {...body,payload_hash:submissionHash(body as never)} as Submission;
}
async function setup(domains:Domain[]=['ABOUT','VIDEO'],channel='UC'+randomUUID().replaceAll('-','').slice(0,22)) {
  const workspace_id='pipeline-'+randomUUID(),as=(role:Principal['role']):Principal=>({workspace_id,subject:role,role});
  const op=as('operator'),worker=as('worker'),receiver=as('sink'),reader=as('reader');
  const plan=await store.createPlan(op,{request_id:randomUUID(),source_mode:'youtube',channel_id:channel,required_domains:domains} as never);
  const owner={schema_version:CONTRACT_VERSION,workspace_id,plan_id:plan.plan_id,execution_epoch:plan.execution_epoch,input_hash:plan.input_hash,workflow_id:plan.workflow_id};
  const videoId=randomUUID().replaceAll('-','').slice(0,11),at=new Date().toISOString();
  const targets={kind:'targets' as const,channel_id:channel,video_ids:[videoId],listed_at:at,window_start:new Date(0).toISOString(),exhausted:true,source:'youtubei:uploads'};
  if(domains.includes('VIDEO'))await store.apply(worker,submission(plan,'video:targets',targets));
  const fact=(kind:PipelineFact['kind'],step:string,id:string,payload:unknown,observed=at):PipelineFact=>PipelineFactSchema.parse({schema_version:'crawl.fact.v1',kind,payload,parser_version:'youtube-raw/1',source_revision:plan.source_revision,
    raw:{schema_version:'crawl.raw.v1',workspace_id,plan_id:plan.plan_id,execution_epoch:plan.execution_epoch,input_hash:plan.input_hash,channel_id:channel,step,unit_id:id,
      captured_at:observed,bucket:'crawl-raw',key:`v1/${workspace_id}/${plan.plan_id}/1/${step}/${id}.json.gz`,sha256:'a'.repeat(64),bytes:40},parsed:{bucket:'crawl-parsed',key:`v1/${workspace_id}/${plan.plan_id}/1/${step}/${id}.youtube-raw-1.${'a'.repeat(64)}.json.gz`,sha256:'b'.repeat(64),bytes:50}});
  const about=fact('ABOUT','ABOUT','channel',{...structuredClone(fixtureChannel),channel_id:channel,channel_url:`https://www.youtube.com/channel/${channel}`,observed_at:at});
  const video:VideoFacts={...structuredClone(fixtureVideo),channel_id:channel,source_content_id:videoId,url:`https://www.youtube.com/watch?v=${videoId}`,
    published_at:new Date(Date.now()-2*86400000).toISOString(),observed_at:at,comments_first_page:null,
    comments_ref:{bucket:'crawl-parsed',key:`v1/${workspace_id}/comments/${videoId}.json.gz`,sha256:'c'.repeat(64),bytes:100},
    comments_summary:{version:1,collected_at:at,sort:'TOP_COMMENTS',total_count:1,returned_count:1}};
  const vf=fact('VIDEO','VIDEO-0',videoId,video),tf=fact('TARGETS','TARGETS','uploads',targets);
  const manifest=(step:string,units:RawReference[])=>({schema_version:'crawl.step.v1',owner,channel_id:channel,step,units,completed_at:at,bucket:'crawl-raw',key:`v1/${workspace_id}/${plan.plan_id}/1/${step}/_manifest.json.gz`});
  return {op,worker,receiver,reader,plan,owner,fact,manifest,about,vf,tf,videoId,channel};
}
async function finishData(t:Awaited<ReturnType<typeof setup>>) {
  for(const f of [t.about,t.tf,t.vf]) {await store.pipelineManifest(t.receiver,t.manifest(f.raw.step,[f.raw]));await sink.apply(f);}
  return store.confirmPipeline(t.receiver,t.plan.plan_id);
}
test('manifests can arrive before facts; completion requires every durable receipt and no comment body reaches PG',async()=>{
  const t=await setup();
  for(const f of [t.about,t.tf,t.vf]) await store.pipelineManifest(t.receiver,t.manifest(f.raw.step,[f.raw]));
  await sink.apply(t.about);await sink.apply(t.tf);
  assert.notEqual((await store.confirmPipeline(t.receiver,t.plan.plan_id)).status,'COMPLETED');
  assert.equal((await store.getInput(t.worker,t.plan.plan_id)).domains.find(d=>d.domain==='VIDEO')!.state,'PENDING');
  await sink.apply(t.vf);
  assert.equal((await store.confirmPipeline(t.receiver,t.plan.plan_id)).status,'COMPLETED');
  const channel=await store.getChannel(t.reader,t.channel);assert.equal(channel.management.state,'managed');
  assert.ok(!JSON.stringify(channel.videos).includes('固定样本评论'));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM crawl_data.ingest_units WHERE plan_id=$1',[t.plan.plan_id])).rows[0].n,3);
  assert.equal((await store.pipelineProgress(t.reader,t.plan.plan_id)).steps.every(s=>s.state==='APPLIED'),true);
});
test('lost notifications are reconciled from saved manifests, including a lost completion notification',async()=>{
  const t=await setup();
  await store.pipelineManifest(t.receiver,t.manifest('ABOUT',[t.about.raw]));
  const pending=await store.pipelineReconciliation(t.receiver);assert.deepEqual(pending.units,[t.about.raw]);
  await sink.apply(t.about);
  assert.equal((await store.getInput(t.worker,t.plan.plan_id)).domains.find(d=>d.domain==='ABOUT')!.state,'PENDING');
  await store.confirmPipeline(t.receiver,t.plan.plan_id);
  assert.equal((await store.getInput(t.worker,t.plan.plan_id)).domains.find(d=>d.domain==='ABOUT')!.state,'APPLIED');
});
test('duplicate facts are idempotent and changed content under the same unit is rejected',async()=>{
  const t=await setup(['ABOUT']);assert.equal(await sink.apply(t.about),'APPLIED');assert.equal(await sink.apply(t.about),'DUPLICATE');
  await assert.rejects(()=>sink.apply({...t.about,payload:{...t.about.payload,title:'changed'}}),/CONFLICT/);
});
test('cancellation fences new writes while a previously durable duplicate remains acknowledgeable',async()=>{
  const t=await setup();await sink.apply(t.about);
  const current=await store.getInput(t.worker,t.plan.plan_id);await store.cancel(t.op,t.plan.plan_id,{command_id:randomUUID(),expected_version:current.plan.version});
  await assert.rejects(()=>sink.apply(t.vf),/STALE_EXECUTION/);assert.equal(await sink.apply(t.about),'DUPLICATE');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM crawl_data.videos WHERE workspace_id=$1',[t.worker.workspace_id])).rows[0].n,0);
});
test('a delayed older observation cannot replace newer channel facts',async()=>{
  const t=await setup(['ABOUT']),old=t.about;
  const newer=await store.createPlan(t.op,{request_id:randomUUID(),source_mode:'youtube',channel_id:t.channel,required_domains:['ABOUT']} as never);
  const fresh=PipelineFactSchema.parse({...old,source_revision:newer.source_revision,payload:{...old.payload,title:'new observation'},
    raw:{...old.raw,plan_id:newer.plan_id,input_hash:newer.input_hash,key:old.raw.key.replace(t.plan.plan_id,newer.plan_id),captured_at:new Date(Date.now()+1000).toISOString()},
    parsed:{...old.parsed,key:old.parsed.key.replace(t.plan.plan_id,newer.plan_id)}});
  await sink.apply(fresh);await sink.apply(old);assert.equal((await store.getChannel(t.reader,t.channel)).title,'new observation');
});
test('a ledger insertion failure rolls the collected fact back in the same transaction',async()=>{
  const t=await setup(['ABOUT']),name='test_ledger_'+randomUUID().replaceAll('-','');
  await pool.query(`CREATE FUNCTION crawl_data.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.plan_id='${t.plan.plan_id}' THEN RAISE EXCEPTION 'injected ledger failure'; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON crawl_data.ingest_units FOR EACH ROW EXECUTE FUNCTION crawl_data.${name}()`);
  try {await assert.rejects(()=>sink.apply(t.about),/injected ledger failure/);assert.equal((await store.getChannel(t.reader,t.channel)).about,null);}
  finally {await pool.query(`DROP TRIGGER ${name} ON crawl_data.ingest_units; DROP FUNCTION crawl_data.${name}()`);}
});
test('Agent waits for persisted domains, hydrates comments from MinIO, then completes through its own ledger',async()=>{
  const t=await setup(['ABOUT','VIDEO','AGENT']);await assert.rejects(()=>store.agentInput(t.worker,t.plan.plan_id),/not complete/);
  assert.notEqual((await finishData(t)).status,'COMPLETED');
  const input=await store.agentInput(t.worker,t.plan.plan_id);assert.equal(input.videos[0]!.comments_first_page!.comments[0]!.text,'固定样本评论');
  const profile=JSON.parse(readFileSync(new URL('../../apps/profile-agent/tests/expected-profile.json',import.meta.url),'utf8'));
  const agent=t.fact('AGENT','AGENT','profile',{channel_id:t.channel,input_hash:input.input_hash,model_version:profile.model_version,taxonomy_version:profile.taxonomy_version,observed_at:new Date().toISOString(),facts:profile.facts});
  await sink.apply(agent);await store.pipelineManifest(t.receiver,t.manifest('AGENT',[agent.raw]));
  assert.equal((await store.confirmPipeline(t.receiver,t.plan.plan_id)).status,'COMPLETED');
  assert.equal((await store.videoComments(t.reader,t.channel,t.videoId)).page!.returned_count,1);
});
test('worker HTTP fact submission cannot bypass the Kafka ledger',async()=>{
  const t=await setup(['ABOUT']);const body={schema_version:CONTRACT_VERSION,submission_id:randomUUID(),plan_id:t.plan.plan_id,execution_epoch:1,input_hash:t.plan.input_hash,
    logical_batch_key:'about:channel',domain:'ABOUT',payload:t.about.payload,domain_complete:true};
  await assert.rejects(()=>store.apply(t.worker,{...body,payload_hash:submissionHash(body as never)} as Submission),/only through the Kafka sink/);
  assert.equal((await store.getChannel(t.reader,t.channel)).about,null);
});
test('incremental sampling compares the frozen baseline after the sink has already updated counts',async()=>{
  const t=await setup();await finishData(t);
  await pool.query(`INSERT INTO control.video_refresh_state(workspace_id,channel_id,video_id,stats_observed_at)
    VALUES($1,$2,$3,now()-interval '10 days') ON CONFLICT(workspace_id,channel_id,video_id) DO UPDATE SET stats_observed_at=EXCLUDED.stats_observed_at`,[t.worker.workspace_id,t.channel,t.videoId]);
  const version=(await store.getChannel(t.reader,t.channel)).management.version;
  const update=await store.updateChannel(t.op,t.channel,{request_id:randomUUID(),expected_version:version,domains:['VIDEO']});
  const context=await store.getInput(t.worker,update.plan_id);assert.equal(context.input.source_mode,'youtube');
  if(context.input.source_mode!=='youtube')throw new Error('source');assert.deepEqual(context.input.recent_sampling!.video_ids,[t.videoId]);
  const at=new Date().toISOString(),discovery={kind:'discovery',channel_id:t.channel,video_ids:[],listed_at:at,scanned_count:1,pages:1,matched_anchor_id:t.videoId,stop_reason:'anchor_matched',source:'youtubei:uploads'};
  await store.apply(t.worker,submission(update,'video:discovery',discovery));
  const ref=(old:PipelineFact,kind:string,step:string,id:string,payload:unknown)=>PipelineFactSchema.parse({...old,kind,payload,source_revision:update.source_revision,
    raw:{...old.raw,plan_id:update.plan_id,input_hash:update.input_hash,step,unit_id:id,captured_at:at,key:`v1/${t.worker.workspace_id}/${update.plan_id}/1/${step}/${id}.json.gz`},
    parsed:{...old.parsed,key:`v1/${t.worker.workspace_id}/${update.plan_id}/1/${step}/${id}.youtube-raw-1.${old.raw.sha256}.json.gz`}});
  const df=ref(t.tf,'TARGETS','TARGETS','uploads',discovery),v=(t.vf.payload as VideoFacts);
  const sample=ref(t.vf,'SAMPLING','SAMPLING',t.videoId,{kind:'samples',observed_at:at,source:'youtubei:video_or_api_fallback',items:[{video_id:t.videoId,
    view_count:v.view_count.value!+500,like_count:v.like_count.value,comment_count:v.comment_count.value,
    metrics:{view_count:{...v.view_count,value:v.view_count.value!+500,status:'estimated',observed_at:at},like_count:v.like_count,comment_count:v.comment_count}}],missing_video_ids:[]});
  for(const fact of [df,sample]) {
    const owner={...t.owner,plan_id:update.plan_id,input_hash:update.input_hash,workflow_id:update.workflow_id};
    await store.pipelineManifest(t.receiver,{...t.manifest(fact.raw.step,[fact.raw]),owner,key:`v1/${t.worker.workspace_id}/${update.plan_id}/1/${fact.raw.step}/_manifest.json.gz`});
    await sink.apply(fact);
  }
  assert.equal((await store.confirmPipeline(t.receiver,update.plan_id)).status,'COMPLETED');
  const results=(await pool.query('SELECT facts FROM control.plan_video_samples WHERE plan_id=$1',[update.plan_id])).rows[0].facts;
  assert.equal(results.view_delta_total,500);assert.equal(results.view_changed_count,1);
  const current=(await store.getChannel(t.reader,t.channel)).videos[0] as VideoFacts;assert.equal(current.view_count.status,'estimated');
  assert.equal('unavailable' in (await store.getChannel(t.reader,t.channel)).videos[0]!,false);
});
test('an Agent result is rejected if collected facts change after its input was hydrated',async()=>{
  const t=await setup(['ABOUT','VIDEO','AGENT']);await finishData(t);const input=await store.agentInput(t.worker,t.plan.plan_id);
  const profile=JSON.parse(readFileSync(new URL('../../apps/profile-agent/tests/expected-profile.json',import.meta.url),'utf8'));
  const agent=t.fact('AGENT','AGENT','profile',{channel_id:t.channel,input_hash:input.input_hash,model_version:profile.model_version,taxonomy_version:profile.taxonomy_version,observed_at:new Date().toISOString(),facts:profile.facts});
  await pool.query(`UPDATE crawl_data.videos SET data=jsonb_set(data,'{title}','"Changed while profiling"') WHERE workspace_id=$1 AND channel_id=$2 AND video_id=$3`,[t.worker.workspace_id,t.channel,t.videoId]);
  await assert.rejects(()=>sink.apply(agent),/INPUT_MISMATCH/);
});
