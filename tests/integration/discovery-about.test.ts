import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '@crawlsystem/store';
import {createPool} from '@crawlsystem/store/config';
import {upsertBindings} from '@crawlsystem/store/discovery';
import {CONTRACT_VERSION,DiscoveryLimitsSchema,UpdateLimitsSchema,type Principal,type Plan,type ChannelFacts} from '@crawlsystem/contracts';
import {fixtureChannel} from '@crawlsystem/contracts/fixtures';
import {submissionHash} from '@crawlsystem/contracts/hash';
import {PipelineFactSchema} from '@crawlsystem/contracts/pipeline';
import {PgSink} from '../../apps/pg-sink/src/sink.ts';
import {prepareDatabase} from './database-ready.ts';
const pool=createPool(),sink=new PgSink(pool);
before(async()=>{await prepareDatabase(pool);});after(async()=>{await pool.end();});
async function setup(count=1,api_daily_limit=1) {
  const workspace='r4-'+randomUUID(),as=(role:Principal['role']):Principal=>({workspace_id:workspace,subject:role,role});
  const store=new Store(pool,UpdateLimitsSchema.parse({api_daily_limit}),DiscoveryLimitsSchema.parse({api_reserve:10000,auto_admit:false}),{enabled:true});
  await upsertBindings(pool,workspace,[{text:'teste',country:'BR',language:'pt',category:'Music',source_type:'MANUAL',source_ref:'r4-test'}]);
  const worker=as('worker'),op=as('operator'),reader=as('reader'),receiver=as('sink');
  const run=(await store.claimQueryRun(worker)).run!;
  assert.equal(run.params.policy_version,'query-clock-2-about','a web search works even with no spare Data API budget');
  const ids=Array.from({length:count},()=>`UC${randomUUID().replaceAll('-','').slice(0,22)}`);
  const page={attempt:1,page:1,items:ids.map(id=>({channel_id:id,video_id:'12345678901'}))};
  await store.queryRunPage(worker,run.run_id,page);
  if(count===3) {
    assert.deepEqual(await store.queryRunPage(worker,run.run_id,{...page,page:2}),{new_channel_ids:[],continue:false},'repeated channels on another page are not new yield');
    assert.deepEqual(await store.queryRunPage(worker,run.run_id,page),{new_channel_ids:ids,continue:true},'replaying the first page preserves its original yield');
  }
  const result=await store.queryRunComplete(worker,run.run_id,{attempt:1,pages:1,stop_reason:'list_end'});
  assert.equal(result.qualification_pending,count);
  assert.equal(result.binding.next_run_at,null);
  // First collections are admitted only into the free slots of a live Worker.
  await store.heartbeat(worker,{worker_id:worker.subject,server_id:'test-node',build_version:'test',accepting_work:true,capacity:2,running_plan_ids:[]});
  return {workspace,store,run,ids,worker,op,reader,receiver};
}
async function about(t:Awaited<ReturnType<typeof setup>>,plan:Plan,subscribers:number|null) {
  const payload:ChannelFacts={...structuredClone(fixtureChannel),channel_id:plan.channel_id,channel_url:`https://www.youtube.com/channel/${plan.channel_id}`,observed_at:new Date().toISOString()};
  payload.subscriber_count={...payload.subscriber_count,value:subscribers,status:subscribers===null?'unresolved':'exact'};
  const raw={schema_version:'crawl.raw.v1',workspace_id:t.workspace,plan_id:plan.plan_id,execution_epoch:plan.execution_epoch,input_hash:plan.input_hash,channel_id:plan.channel_id,step:'ABOUT',unit_id:'channel',captured_at:payload.observed_at,bucket:'crawl-raw',key:`v1/${t.workspace}/${plan.plan_id}/1/ABOUT/channel.json.gz`,sha256:'a'.repeat(64),bytes:40};
  const fact=PipelineFactSchema.parse({schema_version:'crawl.fact.v1',kind:'ABOUT',payload,source_revision:plan.source_revision,parser_version:'youtube-raw/1',raw,parsed:{bucket:'crawl-parsed',key:`v1/${t.workspace}/${plan.plan_id}/1/ABOUT/channel.youtube-raw-1.${'a'.repeat(64)}.json.gz`,sha256:'b'.repeat(64),bytes:50}});
  const owner={schema_version:CONTRACT_VERSION,workspace_id:t.workspace,plan_id:plan.plan_id,execution_epoch:plan.execution_epoch,input_hash:plan.input_hash,workflow_id:plan.workflow_id};
  await t.store.pipelineManifest(t.receiver,{schema_version:'crawl.step.v1',owner,channel_id:plan.channel_id,step:'ABOUT',units:[raw],completed_at:payload.observed_at,bucket:'crawl-raw',key:`v1/${t.workspace}/${plan.plan_id}/1/ABOUT/_manifest.json.gz`});
  assert.notEqual((await t.store.confirmPipeline(t.receiver,plan.plan_id)).status,'CANCELLED','an archived response alone is not qualification');
  await sink.apply(fact);
  return {fact,plan:await t.store.confirmPipeline(t.receiver,plan.plan_id)};
}

test('automatic import retry retains the original About gate and stops when qualification rejects it',async()=>{
  const t=await setup(1,10000),c=(await t.store.candidates(t.reader)).items[0]!;
  await t.store.candidateCommand(t.op,c.channel_id,{action:'admit',expected_version:c.version});
  const plan=(await t.store.scheduleUpdates(t.workspace))[0]!;
  const failed={event_id:randomUUID(),execution_epoch:1,worker_id:'worker',phase:'ABOUT',kind:'FAILED' as const,domain:'ABOUT' as const,message:'Temporary outage',error_code:'UNAVAILABLE' as const};
  await t.store.event(t.worker,plan.plan_id,failed);
  await pool.query("UPDATE control.channel_imports SET retry_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1",[t.workspace]);
  const retry=(await t.store.scheduleUpdates(t.workspace))[0]!;
  const nextInput=(await t.store.getInput(t.worker,retry.plan_id)).input,oldInput=(await t.store.getInput(t.worker,plan.plan_id)).input;
  assert.ok(nextInput.source_mode==='youtube' && oldInput.source_mode==='youtube');
  assert.deepEqual(nextInput.discovery_qualification,oldInput.discovery_qualification);
  assert.equal((await about(t,retry,999)).plan.status,'CANCELLED');
  assert.equal((await t.store.channelImports(t.reader)).items[0]!.state,'rejected');
  assert.deepEqual(await t.store.scheduleUpdates(t.workspace,new Date(Date.now()+86400000)),[]);
});

test('explicit candidate rejection wins over a pending automatic import retry',async()=>{
  const t=await setup(1,10000),c=(await t.store.candidates(t.reader)).items[0]!;
  await t.store.candidateCommand(t.op,c.channel_id,{action:'admit',expected_version:c.version});
  const plan=(await t.store.scheduleUpdates(t.workspace))[0]!;
  await t.store.event(t.worker,plan.plan_id,{event_id:randomUUID(),execution_epoch:1,worker_id:'worker',phase:'ABOUT',kind:'FAILED',domain:'ABOUT',message:'Temporary outage',error_code:'UNAVAILABLE'});
  const updated=(await t.store.candidates(t.reader)).items[0]!;
  await t.store.candidateCommand(t.op,c.channel_id,{action:'reject',expected_version:updated.version,reason:'Operator rejected this channel'});
  assert.equal((await t.store.channelImports(t.reader)).items[0]!.retry!.blocked_reason,'candidate_rejected');
  assert.deepEqual(await t.store.scheduleUpdates(t.workspace,new Date(Date.now()+86400000)),[]);
});

test('automatic and manual retry keep an explicit override and its original search provenance',async()=>{
  const t=await setup(1,10000),c=(await t.store.candidates(t.reader)).items[0]!;
  await t.store.candidateCommand(t.op,c.channel_id,{action:'admit',expected_version:c.version});
  const first=(await t.store.scheduleUpdates(t.workspace))[0]!;await about(t,first,500);
  const rejected=(await t.store.candidates(t.reader)).items[0]!;
  await t.store.candidateCommand(t.op,c.channel_id,{action:'admit',expected_version:rejected.version,reason:'Approved exception'});
  const override=(await t.store.scheduleUpdates(t.workspace))[0]!;await about(t,override,500);
  await t.store.event(t.worker,override.plan_id,{event_id:randomUUID(),execution_epoch:1,worker_id:'worker',phase:'VIDEO',kind:'FAILED',domain:'VIDEO',message:'Temporary outage',error_code:'UNAVAILABLE'});
  await pool.query("UPDATE control.channel_imports SET retry_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1",[t.workspace]);
  const retry=(await t.store.scheduleUpdates(t.workspace))[0]!,input=(await t.store.getInput(t.worker,retry.plan_id)).input;
  assert.ok(input.source_mode==='youtube');assert.equal(input.discovery_qualification!.override,true);assert.equal(input.discovery_qualification!.run_id,t.run.run_id);
  await t.store.event(t.worker,retry.plan_id,{event_id:randomUUID(),execution_epoch:1,worker_id:'worker',phase:'ABOUT',kind:'FAILED',domain:'ABOUT',message:'Temporary outage',error_code:'UNAVAILABLE'});
  const failed=(await t.store.candidates(t.reader)).items[0]!;await t.store.candidateCommand(t.op,c.channel_id,{action:'admit',expected_version:failed.version});
  const manual=(await t.store.scheduleUpdates(t.workspace))[0]!,manualInput=(await t.store.getInput(t.worker,manual.plan_id)).input;
  assert.ok(manualInput.source_mode==='youtube');assert.deepEqual(manualInput.discovery_qualification,input.discovery_qualification);
});
test('discovery deduplicates across pages, preserves replay and blocks another search until About decisions',async()=>{
  const t=await setup(3);
  const listed=await t.store.candidates(t.reader);assert.equal(listed.items.length,3);assert.ok(listed.items.every(c=>c.state==='DISCOVERED' && c.qualification?.state==='PENDING'));
  assert.equal((await t.store.claimQueryRun(t.worker)).idle_reason,'no_due');
  await assert.rejects(()=>t.store.queryRunPermit(t.worker,t.run.run_id,{attempt:1,request_id:randomUUID(),endpoint:'channels'}));
  const replay=await t.store.queryRunComplete(t.worker,t.run.run_id,{attempt:1,pages:1,stop_reason:'list_end'});assert.equal(replay.new_channels,3);
  for(const id of t.ids) {const plan=await t.store.createPlan(t.op,{request_id:randomUUID(),source_mode:'youtube',channel_id:id,required_domains:['ABOUT']} as never);await about(t,plan,1000);}
  const result=(await pool.query('SELECT qualified_new,qualification_pending,clock_settled_at FROM control.query_runs WHERE run_id=$1',[t.run.run_id])).rows[0];
  assert.equal(result.qualified_new,3);assert.equal(result.qualification_pending,0);assert.ok(result.clock_settled_at);
  const binding=(await t.store.queries(t.reader)).items[0]!;assert.equal(binding.cadence,'WEEK');
});
test('below-threshold and unknown subscribers stop before video/Agent, preserve About and never manage the channel',async()=>{
  for(const count of [999,null]) {
    const t=await setup(),id=t.ids[0]!;
    let c=(await t.store.candidates(t.reader)).items[0]!;
    await t.store.candidateCommand(t.op,id,{action:'admit',expected_version:c.version});
    const plan=await t.store.createPlan(t.op,{request_id:randomUUID(),source_mode:'youtube',channel_id:id} as never);
    await pool.query("UPDATE control.channel_imports SET state='planned',plan_id=$3 WHERE workspace_id=$1 AND channel_id=$2",[t.workspace,id,plan.plan_id]);
    const input=await t.store.getInput(t.worker,plan.plan_id);assert.equal(input.input.source_mode==='youtube' && input.input.discovery_qualification?.min_subscribers,1000);
    const result=await about(t,plan,count);assert.equal(result.plan.status,'CANCELLED');
    assert.equal((await sink.apply(result.fact)),'DUPLICATE');assert.equal((await t.store.confirmPipeline(t.receiver,plan.plan_id)).status,'CANCELLED');
    c=(await t.store.candidates(t.reader)).items[0]!;assert.equal(c.state,'UNQUALIFIED');assert.equal(c.import_state,'rejected');assert.equal(c.reason,count===null?'hidden_subscribers':'below_threshold');
    assert.equal((await t.store.getChannel(t.reader,id)).management.state,null);
    const ledger=(await pool.query('SELECT step FROM crawl_data.ingest_units WHERE plan_id=$1',[plan.plan_id])).rows;assert.deepEqual(ledger,[{step:'ABOUT'}]);
    const binding=(await t.store.queries(t.reader)).items[0]!;assert.equal(binding.cadence,'MONTH');assert.equal(binding.empty_runs,1);
  }
});
test('technical failure holds the clock and retries with the frozen threshold; explicit override requires a reason',async()=>{
  const t=await setup(),id=t.ids[0]!;
  const candidate=(await t.store.candidates(t.reader)).items[0]!;
  await t.store.candidateCommand(t.op,id,{action:'admit',expected_version:candidate.version});
  const plan=await t.store.createPlan(t.op,{request_id:randomUUID(),source_mode:'youtube',channel_id:id} as never);
  await pool.query("UPDATE control.channel_imports SET state='planned',plan_id=$3 WHERE workspace_id=$1 AND channel_id=$2",[t.workspace,id,plan.plan_id]);
  await t.store.event(t.worker,plan.plan_id,{event_id:randomUUID(),execution_epoch:1,worker_id:'worker',phase:'ABOUT',kind:'FAILED',domain:'ABOUT',message:'Network failure',error_code:'BUDGET_EXHAUSTED'});
  const r=(await pool.query('SELECT qualification_pending,clock_settled_at FROM control.query_runs WHERE run_id=$1',[t.run.run_id])).rows[0];assert.equal(r.qualification_pending,1);assert.equal(r.clock_settled_at,null);
  let c=(await t.store.candidates(t.reader)).items[0]!;assert.equal(c.import_state,'failed');
  await t.store.candidateCommand(t.op,id,{action:'admit',expected_version:c.version});
  const retry=await t.store.createPlan(t.op,{request_id:randomUUID(),source_mode:'youtube',channel_id:id} as never);
  const input=await t.store.getInput(t.worker,retry.plan_id);assert.equal(input.input.source_mode==='youtube' && input.input.discovery_qualification?.min_subscribers,1000);
  await about(t,retry,500);
  c=(await t.store.candidates(t.reader)).items[0]!;
  await assert.rejects(()=>t.store.candidateCommand(t.op,id,{action:'admit',expected_version:c.version}),/requires a reason/);
  await t.store.candidateCommand(t.op,id,{action:'admit',reason:'Operator exception',expected_version:c.version});
  const override=await t.store.createPlan(t.op,{request_id:randomUUID(),source_mode:'youtube',channel_id:id,required_domains:['ABOUT']} as never);
  assert.equal((await about(t,override,500)).plan.status,'COMPLETED');
  const row=(await pool.query('SELECT qualified_new FROM control.query_runs WHERE run_id=$1',[t.run.run_id])).rows[0];assert.equal(row.qualified_new,0,'overrides never revise an already settled historical clock');
});
test('manual rejection resolves pending decisions and a disabled binding stays disabled',async()=>{
  const t=await setup();await t.store.queryCommand(t.op,t.run.binding_id,{action:'disable',reason:'pause',expected_version:1});
  const c=(await t.store.candidates(t.reader)).items[0]!;
  await t.store.candidateCommand(t.op,c.channel_id,{action:'reject',reason:'Irrelevant',expected_version:c.version});
  await assert.rejects(()=>t.store.createPlan(t.op,{request_id:randomUUID(),source_mode:'youtube',channel_id:c.channel_id} as never),/was rejected/);
  const binding=(await t.store.queries(t.reader)).items[0]!;assert.equal(binding.state,'DISABLED');assert.equal(binding.next_run_at,null);
});
test('automatic admission queues unvalidated candidates fairly and import-created plans use the R3 gate',async()=>{
  const t=await setup(3);
  const scheduler=new Store(pool,UpdateLimitsSchema.parse({}),DiscoveryLimitsSchema.parse({auto_admit:true,import_buffer:2}),{enabled:true});
  await scheduler.heartbeat(t.worker,{worker_id:t.worker.subject,server_id:'test-node',build_version:'test',accepting_work:true,capacity:1,running_plan_ids:[]});
  assert.equal((await scheduler.admitCandidates(t.workspace)).length,2);
  const plans=await scheduler.scheduleUpdates(t.workspace);assert.equal(plans.length,1);
  const input=await scheduler.getInput(t.worker,plans[0]!.plan_id);
  assert.equal(input.input.pipeline_version,'r3.v1');assert.equal(input.input.source_mode==='youtube' && input.input.discovery_qualification?.min_subscribers,1000);
  assert.equal((await scheduler.channelImports(t.reader)).counts.queued,1,'the buffer and the one Worker slot both hold');
  const plan=plans[0]!;
  const navigation={schema_version:CONTRACT_VERSION,plan_id:plan.plan_id,execution_epoch:1,input_hash:plan.input_hash,submission_id:randomUUID(),logical_batch_key:'video:targets',domain:'VIDEO',domain_complete:false,payload:{kind:'targets',channel_id:plan.channel_id,video_ids:[],listed_at:new Date().toISOString(),window_start:new Date(0).toISOString(),exhausted:true,source:'youtubei:uploads'}};
  await assert.rejects(()=>scheduler.apply(t.worker,{...navigation,payload_hash:submissionHash(navigation as never)} as never),(error:any)=>error.code==='DOMAIN_INCOMPLETE');
  assert.equal((await about(t,plan,999)).plan.status,'CANCELLED');
});
test('operators can close a failed qualification explicitly without classifying the failure as an empty search',async()=>{
  const t=await setup(),id=t.ids[0]!,c=(await t.store.candidates(t.reader)).items[0]!;
  await t.store.candidateCommand(t.op,id,{action:'admit',expected_version:c.version});
  const plan=await t.store.createPlan(t.op,{request_id:randomUUID(),source_mode:'youtube',channel_id:id} as never);
  await t.store.event(t.worker,plan.plan_id,{event_id:randomUUID(),execution_epoch:1,worker_id:'worker',phase:'ABOUT',kind:'FAILED',domain:'ABOUT',message:'Network failure',error_code:'BUDGET_EXHAUSTED'});
  assert.equal((await t.store.queries(t.reader)).items[0]!.empty_runs,0);
  const failed=(await t.store.candidates(t.reader)).items[0]!;
  await t.store.candidateCommand(t.op,id,{action:'reject',reason:'Stop pursuing this channel',expected_version:failed.version});
  assert.equal((await t.store.queries(t.reader)).items[0]!.empty_runs,1);
  assert.equal((await t.store.candidates(t.reader)).items[0]!.state,'REJECTED');
});
