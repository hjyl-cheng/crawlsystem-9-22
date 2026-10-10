import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '@crawlsystem/store';
import {createPool} from '@crawlsystem/store/config';
import {contentHash} from '@crawlsystem/contracts/hash';
import type {Principal} from '@crawlsystem/contracts';
import {FailureReportSchema,OpsEventSchema} from '@crawlsystem/contracts/analytics';
import {PgSink} from '../../apps/pg-sink/src/sink.ts';
import {fixtureChannel} from '@crawlsystem/contracts/fixtures';
import {prepareDatabase} from './database-ready.ts';
const pool=createPool(),store=new Store(pool,undefined,undefined,{enabled:true});
before(()=>prepareDatabase(pool));after(()=>pool.end());
async function setup() {
 const workspace_id='r5-test-'+randomUUID(),op:Principal={workspace_id,subject:'operator',role:'operator'},reader:Principal={...op,role:'reader'},analytics:Principal={...op,role:'analytics'},worker:Principal={...op,subject:'worker',role:'worker'};
 const plan=await store.createPlan(op,{request_id:randomUUID(),fixture_id:'channel-basic-v1',required_domains:['ABOUT']});
 const raw={schema_version:'crawl.raw.v1' as const,workspace_id,plan_id:plan.plan_id,execution_epoch:1,input_hash:plan.input_hash,channel_id:plan.channel_id,step:'ABOUT',unit_id:'channel',bucket:'crawl-raw' as const,key:`v1/${workspace_id}/${plan.plan_id}/1/ABOUT/channel.json.gz`,sha256:'a'.repeat(64),bytes:20,captured_at:new Date().toISOString()};
 const report=FailureReportSchema.parse({report_id:randomUUID(),stage:'PARSER',code:'INVALID_FACT',plan_id:plan.plan_id,execution_epoch:1,step:'ABOUT',unit_id:'channel',raw,attempts:3});
 const fact={schema_version:'crawl.fact.v1',kind:'ABOUT',raw,parsed:{bucket:'crawl-parsed',key:raw.key.replace('.json.gz',`.youtube-raw-1.${raw.sha256}.json.gz`),sha256:'b'.repeat(64),bytes:10},parser_version:'youtube-raw/1',source_revision:plan.source_revision,payload:fixtureChannel};
 return {op,reader,analytics,worker,plan,raw,report,fact};
}
test('failure reports aggregate only distinct reports and stay workspace isolated',async()=>{
 const t=await setup(),a=await store.reportFailure(t.analytics,t.report),b=await store.reportFailure(t.analytics,t.report);assert.equal(a.occurrences,1);assert.equal(b.occurrences,1);
 const c=await store.reportFailure(t.analytics,{...t.report,report_id:randomUUID()});assert.equal(c.failure_id,a.failure_id);assert.equal(c.occurrences,2);assert.equal(c.attempts,6);
 await assert.rejects(()=>store.reportFailure(t.analytics,{...t.report,attempts:2}),{code:'CONFLICT'});
 await assert.rejects(()=>store.failure({...t.reader,workspace_id:'other'},a.failure_id),{code:'NOT_FOUND'});
 await assert.rejects(()=>store.reportFailure(t.worker,t.report),{code:'FORBIDDEN'});
 await assert.rejects(()=>store.reportFailure(t.analytics,{...t.report,report_id:randomUUID(),raw:{...t.raw,input_hash:'sha256:'+'0'.repeat(64)}}),{code:'INPUT_MISMATCH'});
 await assert.rejects(()=>store.reportFailure(t.analytics,{...t.report,report_id:randomUUID(),raw:{...t.raw,channel_id:'other'}}),{code:'INPUT_MISMATCH'});
});
test('retry is version fenced, idempotent, leased and resolves only after durable ingestion',async()=>{
 const t=await setup(),f=await store.reportFailure(t.analytics,t.report),command={command_id:randomUUID(),expected_version:f.version,action:'retry' as const,reason:'修复解析后重放'};
 await assert.rejects(()=>store.commandFailure(t.reader,f.failure_id,command),{code:'FORBIDDEN'});
 const retry=await store.commandFailure(t.op,f.failure_id,command);assert.equal(retry.state,'RETRYING');assert.equal((await store.commandFailure(t.op,f.failure_id,command)).version,retry.version);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM control.failure_replays WHERE failure_id=$1',[f.failure_id])).rows[0].n,1);
 const items=await store.telemetryReplays(t.analytics);assert.equal(items.length,1);assert.equal((await store.telemetryReplays(t.analytics)).length,0);
 await assert.rejects(()=>store.telemetryReplayDone(t.analytics,items[0]!.replay_id,randomUUID(),true),{code:'STALE_EXECUTION'});
 await store.telemetryReplayDone(t.analytics,items[0]!.replay_id,items[0]!.lease_token,true);assert.equal((await store.failure(t.reader,f.failure_id)).state,'RETRYING');
 await new PgSink(pool).apply(t.fact);assert.equal((await store.failure(t.reader,f.failure_id)).state,'RESOLVED');
});
test('ignore preserves reasons and obsolete epochs cannot be replayed',async()=>{
 const t=await setup(),f=await store.reportFailure(t.analytics,{...t.report,code:'STALE_EXECUTION'});assert.equal(f.retryable,false);
 await assert.rejects(()=>store.commandFailure(t.op,f.failure_id,{command_id:randomUUID(),expected_version:f.version,action:'retry',reason:'尝试重放旧代次'}),{code:'CONFLICT'});
 const ignored=await store.commandFailure(t.op,f.failure_id,{command_id:randomUUID(),expected_version:f.version,action:'ignore',reason:'旧代次消息已失效'});assert.equal(ignored.state,'IGNORED');assert.equal(ignored.reason,'旧代次消息已失效');
});
test('failed-plan retry creates a new frozen bounded plan and never resurrects the old epoch',async()=>{
 const t=await setup();await store.event(t.worker,t.plan.plan_id,{event_id:randomUUID(),execution_epoch:1,worker_id:t.worker.subject,kind:'FAILED',phase:'ABOUT',message:'test failure',error_code:'UNAVAILABLE',domain:'ABOUT'});
 const f=(await store.failures(t.reader)).items.find(f=>f.code==='UNAVAILABLE')!;assert.equal(f.retryable,true);
 const r=await store.commandFailure(t.op,f.failure_id,{command_id:randomUUID(),expected_version:f.version,action:'retry',reason:'依赖恢复重新采集'});assert.notEqual(r.retry_plan_id,t.plan.plan_id);
 const old=await store.getPlan(t.reader,t.plan.plan_id),next=await store.getInput(t.worker,r.retry_plan_id!);assert.equal(old.plan.status,'FAILED');assert.equal(old.plan.execution_epoch,2);assert.equal(next.plan.status,'QUEUED');assert.equal(next.plan.execution_epoch,1);assert.equal(next.input.pipeline_version,'r3.v1');
});
test('sanitized outbox is transactional, consumers cannot acknowledge other workspaces',async()=>{
 const t=await setup();await store.event(t.worker,t.plan.plan_id,{event_id:randomUUID(),execution_epoch:1,worker_id:t.worker.subject,kind:'ERROR',phase:'ABOUT',domain:null,message:'cookie=private visitor data',error_code:'UNAVAILABLE'});
 const messages=await store.telemetryOutbox(t.analytics);messages.forEach(e=>OpsEventSchema.parse(e));assert.equal(JSON.stringify(messages).includes('private'),false);assert.equal(JSON.stringify(messages).includes('cookie'),false);
 await store.telemetryAck({...t.analytics,workspace_id:'other'},messages.map(e=>e.event_id),true);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM telemetry.outbox WHERE workspace_id=$1 AND archived_at IS NOT NULL',[t.op.workspace_id])).rows[0].n,0);
 await store.telemetryAck(t.analytics,messages.map(e=>e.event_id),true);assert.equal((await store.telemetryOutbox(t.analytics)).length,0);
});
test('observation events preserve the entity and metrics, and plan creation has its own history identity',async()=>{
 const t=await setup();await new PgSink(pool).apply(t.fact);
 const events=await store.telemetryOutbox(t.analytics),fact=events.find(e=>e.kind==='FACT')!;
 assert.equal(events.filter(e=>e.kind==='PLAN_CREATED').length,1);assert.equal(fact.entity_id,'channel');assert.equal(fact.views,fixtureChannel.total_view_count.value);assert.equal(fact.subscribers,fixtureChannel.subscriber_count.value);
});
test('worker failure evidence is owner scoped, archived separately and never reaches telemetry',async()=>{
 const t=await setup(),event={event_id:randomUUID(),execution_epoch:1,worker_id:t.worker.subject,kind:'ERROR' as const,phase:'AGENT',domain:'AGENT' as const,message:'Profile failed',error_code:'UNAVAILABLE' as const,
  evidence_ref:{bucket:'crawl-raw' as const,key:`failures/v1/${t.op.workspace_id}/${t.plan.plan_id}/1/AGENT/profile/error.json.gz`,sha256:'e'.repeat(64),bytes:40}};
 await store.event(t.worker,t.plan.plan_id,event);const f=(await store.failures(t.reader)).items[0]!;assert.equal(f.evidence_state,'PENDING');assert.equal(f.raw_object?.key,event.evidence_ref.key);
 const pending=await store.telemetryEvidence(t.analytics);assert.equal(pending[0]?.raw.key,event.evidence_ref.key);
 await assert.rejects(()=>store.event(t.worker,t.plan.plan_id,{...event,event_id:randomUUID(),evidence_ref:{...event.evidence_ref,key:'failures/v1/other/private'}}),{code:'INPUT_MISMATCH'});
 assert.equal(JSON.stringify(await store.telemetryOutbox(t.analytics)).includes('error.json.gz'),false);
});
test('retention protects unarchived, active and unresolved owners and keeps duplicate-event hashes',async()=>{
 const t=await setup(),event={event_id:randomUUID(),execution_epoch:1,worker_id:t.worker.subject,kind:'STARTED' as const,phase:'ABOUT',domain:null,message:'started'};
 await store.event(t.worker,t.plan.plan_id,event);await new PgSink(pool).apply(t.fact);
 await store.pipelineManifest({...t.worker,role:'sink'},{schema_version:'crawl.step.v1',owner:{schema_version:'m1.v1',workspace_id:t.op.workspace_id,plan_id:t.plan.plan_id,execution_epoch:1,input_hash:t.plan.input_hash,workflow_id:t.plan.workflow_id},channel_id:t.plan.channel_id,step:'ABOUT',units:[t.raw],completed_at:new Date().toISOString(),bucket:'crawl-raw',key:t.raw.key.replace('channel','_manifest')});
 await store.confirmPipeline({...t.worker,role:'sink'},t.plan.plan_id);
 await pool.query("UPDATE control.plans SET finished_at=clock_timestamp()-interval '40 days' WHERE plan_id=$1",[t.plan.plan_id]);
 assert.equal((await store.maintain(t.op)).units,0);
 await pool.query('UPDATE telemetry.outbox SET archived_at=clock_timestamp() WHERE workspace_id=$1',[t.op.workspace_id]);
 const dry=await store.maintain(t.op);assert.equal(dry.units,1);assert.equal(dry.events,1);
 const f=await store.reportFailure(t.analytics,t.report);assert.equal((await store.maintain(t.op)).units,0);
 await store.commandFailure(t.op,f.failure_id,{command_id:randomUUID(),expected_version:f.version,action:'ignore',reason:'历史计划已完成'});
 await pool.query('UPDATE telemetry.outbox SET archived_at=clock_timestamp() WHERE workspace_id=$1',[t.op.workspace_id]);
 await store.maintain(t.op,false);
 assert.equal((await pool.query('SELECT fact_hash,fact FROM crawl_data.ingest_units WHERE plan_id=$1',[t.plan.plan_id])).rows[0].fact.archived,true);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM crawl_data.channels WHERE workspace_id=$1',[t.op.workspace_id])).rows[0].n,1);
 assert.equal((await store.event(t.worker,t.plan.plan_id,event)).accepted,true);
 await assert.rejects(()=>store.event(t.worker,t.plan.plan_id,{...event,message:'changed'}),{code:'CONFLICT'});
});
