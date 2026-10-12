import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '@crawlsystem/store';
import {createPool} from '@crawlsystem/store/config';
import type {Principal} from '@crawlsystem/contracts';
import {PgSink} from '../../apps/pg-sink/src/sink.ts';
import {fixtureChannel} from '@crawlsystem/contracts/fixtures';
import {prepareDatabase} from './database-ready.ts';
import {upsertBindings} from '@crawlsystem/store/discovery';
const pool=createPool(),store=new Store(pool,undefined,undefined,{enabled:true});
before(()=>prepareDatabase(pool));after(()=>pool.end());
async function setup(complete=true,age=true) {
 const workspace_id='retention-'+randomUUID(),op:Principal={workspace_id,subject:'operator',role:'operator'},analytics:Principal={...op,role:'analytics'},worker:Principal={...op,role:'worker',subject:'worker'},sink:Principal={...op,role:'sink'};
 const plan=await store.createPlan(op,{request_id:randomUUID(),fixture_id:'channel-basic-v1',required_domains:['ABOUT']});
 const raw={schema_version:'crawl.raw.v1' as const,workspace_id,plan_id:plan.plan_id,execution_epoch:1,input_hash:plan.input_hash,channel_id:plan.channel_id,step:'ABOUT',unit_id:'channel',bucket:'crawl-raw' as const,key:`v1/${workspace_id}/${plan.plan_id}/1/ABOUT/channel.json.gz`,sha256:'a'.repeat(64),bytes:20,captured_at:new Date().toISOString()};
 const fact={schema_version:'crawl.fact.v1',kind:'ABOUT',raw,parsed:{bucket:'crawl-parsed',key:raw.key.replace('.json.gz',`.youtube-raw-1.${raw.sha256}.json.gz`),sha256:'b'.repeat(64),bytes:10},parser_version:'youtube-raw/1',source_revision:plan.source_revision,payload:fixtureChannel};
 const manifest={schema_version:'crawl.step.v1',owner:{schema_version:'m1.v1',workspace_id,plan_id:plan.plan_id,execution_epoch:1,input_hash:plan.input_hash,workflow_id:plan.workflow_id},channel_id:plan.channel_id,step:'ABOUT',units:[raw],completed_at:new Date().toISOString(),bucket:'crawl-raw',key:raw.key.replace('channel.json.gz','_manifest.json.gz')};
 await store.pipelineManifest(sink,manifest);
 if(complete) {await new PgSink(pool).apply(fact);await store.confirmPipeline(sink,plan.plan_id);}
 if(age) {
  await pool.query("UPDATE control.plans SET finished_at=clock_timestamp()-interval '25 hours' WHERE plan_id=$1",[plan.plan_id]);
  await pool.query("UPDATE control.pipeline_steps SET created_at=clock_timestamp()-interval '25 hours' WHERE plan_id=$1",[plan.plan_id]);
  await pool.query("UPDATE crawl_data.ingest_units SET applied_at=clock_timestamp()-interval '25 hours' WHERE plan_id=$1",[plan.plan_id]);
 }
 await pool.query('UPDATE telemetry.outbox SET archived_at=clock_timestamp() WHERE workspace_id=$1',[workspace_id]);
 return {op,analytics,worker,sink,plan,raw,fact,manifest};
}
test('success requires a full day after completion AND ingestion; activity and unconfirmed steps remain protected',async()=>{
 const good=await setup();assert.equal((await store.rawCleanupPreview(good.op)).length,2);
 const recent=await setup(true,false);assert.deepEqual(await store.rawCleanupClaim(recent.analytics),[]);
 const active=await setup(false);assert.deepEqual(await store.rawCleanupClaim(active.analytics),[]);
 await pool.query("UPDATE control.plans SET status='COMPLETED' WHERE plan_id=$1",[active.plan.plan_id]);
 assert.deepEqual(await store.rawCleanupClaim(active.analytics),[]);
 const late=await setup();await pool.query('UPDATE crawl_data.ingest_units SET applied_at=clock_timestamp() WHERE plan_id=$1',[late.plan.plan_id]);assert.deepEqual(await store.rawCleanupClaim(late.analytics),[]);
 const unarchived=await setup();await pool.query('UPDATE telemetry.outbox SET archived_at=NULL WHERE workspace_id=$1',[unarchived.op.workspace_id]);assert.deepEqual(await store.rawCleanupClaim(unarchived.analytics),[]);
});
test('failure, pending evidence and replay veto even queued candidates; failed plans never qualify',async()=>{
 const t=await setup();await store.rawCleanupPreview(t.op);
 const f=await store.reportFailure(t.analytics,{report_id:randomUUID(),stage:'PARSER',code:'INVALID_FACT',plan_id:t.plan.plan_id,execution_epoch:1,step:'ABOUT',unit_id:'channel',raw:t.raw});
 assert.deepEqual(await store.rawCleanupClaim(t.analytics),[]);
 await pool.query("UPDATE control.failures SET state='RESOLVED' WHERE failure_id=$1",[f.failure_id]);
 await pool.query('UPDATE telemetry.outbox SET archived_at=clock_timestamp() WHERE workspace_id=$1',[t.op.workspace_id]);
 assert.deepEqual(await store.rawCleanupClaim(t.analytics),[]);
 await store.telemetryEvidenceDone(t.analytics,f.failure_id,{bucket:'crawl-evidence',key:'r5/evidence.json.gz',sha256:'c'.repeat(64),bytes:20},'SAVED');
 await pool.query('INSERT INTO control.failure_replays(replay_id,workspace_id,failure_id,raw) VALUES($1,$2,$3,$4)',[randomUUID(),t.op.workspace_id,f.failure_id,t.raw]);
 assert.deepEqual(await store.rawCleanupClaim(t.analytics),[]);
 await pool.query("UPDATE control.failure_replays SET state='DONE' WHERE failure_id=$1",[f.failure_id]);assert.equal((await store.rawCleanupClaim(t.analytics)).length,2);
 const failed=await setup();await pool.query("UPDATE control.plans SET status='FAILED' WHERE plan_id=$1",[failed.plan.plan_id]);assert.deepEqual(await store.rawCleanupClaim(failed.analytics),[]);
});
test('mismatched ledger, foreign paths and obsolete epochs are protected',async()=>{
 const t=await setup();await pool.query("UPDATE crawl_data.ingest_units SET raw_hash=$2 WHERE plan_id=$1",[t.plan.plan_id,'f'.repeat(64)]);assert.deepEqual(await store.rawCleanupClaim(t.analytics),[]);
 const foreign=await setup();await pool.query("UPDATE control.pipeline_steps SET manifest=jsonb_set(manifest,'{key}',to_jsonb('v1/other/private.json.gz'::text)) WHERE plan_id=$1",[foreign.plan.plan_id]);assert.deepEqual(await store.rawCleanupClaim(foreign.analytics),[]);
 const old=await setup();await store.rawCleanupPreview(old.op);await pool.query('UPDATE control.plans SET execution_epoch=2 WHERE plan_id=$1',[old.plan.plan_id]);assert.deepEqual(await store.rawCleanupClaim(old.analytics),[]);
});
test('leases fence acknowledgements, crashes resume, partial failures back off, facts are preserved',async()=>{
 const t=await setup(),items=await store.rawCleanupClaim(t.analytics,1);assert.equal(items.length,1);const item=items[0]!;
 assert.equal((await store.rawCleanupClaim(t.analytics,100)).length,1);
 await assert.rejects(()=>store.rawCleanupDone({...t.analytics,workspace_id:'other'},[{key:item.key,lease_token:item.lease_token,outcome:'DELETED',bytes:20}]),{code:'STALE_EXECUTION'});
 await pool.query("UPDATE telemetry.raw_retention SET lease_until=clock_timestamp()-interval '1 minute' WHERE workspace_id=$1 AND object_key=$2",[t.op.workspace_id,item.key]);
 const replay=await store.rawCleanupClaim(t.analytics,1);assert.notEqual(replay[0]!.lease_token,item.lease_token);
 await assert.rejects(()=>store.rawCleanupDone(t.analytics,[{key:item.key,lease_token:item.lease_token,outcome:'DELETED',bytes:20}]),{code:'STALE_EXECUTION'});
 await store.rawCleanupDone(t.analytics,[{key:replay[0]!.key,lease_token:replay[0]!.lease_token,outcome:'ERROR',bytes:0,error:'DEPENDENCY_UNAVAILABLE'}]);
 assert.deepEqual(await store.rawCleanupClaim(t.analytics),[/* the second object's unexpired lease remains held */]);
 await pool.query('UPDATE telemetry.raw_retention SET retry_at=NULL,lease_until=clock_timestamp()-interval \'1 minute\' WHERE workspace_id=$1',[t.op.workspace_id]);
 const final=await store.rawCleanupClaim(t.analytics);assert.equal(final.length,2);
 await store.rawCleanupDone(t.analytics,final.map(i=>({key:i.key,lease_token:i.lease_token,outcome:'DELETED',bytes:20})));
 await store.rawCleanupDone(t.analytics,final.map(i=>({key:i.key,lease_token:i.lease_token,outcome:'DELETED',bytes:20})));
 assert.deepEqual(await store.rawCleanupClaim(t.analytics),[]);
 assert.equal((await store.rawRetentionStatus(t.op)).deleted,2);
 assert.equal((await pool.query('SELECT fact FROM crawl_data.ingest_units WHERE plan_id=$1',[t.plan.plan_id])).rows[0].fact.kind,'ABOUT');
 assert.equal((await pool.query('SELECT count(*)::int n FROM crawl_data.channels WHERE workspace_id=$1',[t.op.workspace_id])).rows[0].n,1);
 await assert.rejects(()=>store.rawCleanupClaim(t.op),{code:'FORBIDDEN'});await assert.rejects(()=>store.rawCleanupPreview(t.analytics),{code:'FORBIDDEN'});
});
test('successful searches require committed pages and settled qualification; failed attempt archives remain protected',async()=>{
 const workspace_id='retention-search-'+randomUUID(),op:Principal={workspace_id,subject:'operator',role:'operator'},worker:Principal={...op,subject:'worker',role:'worker'},analytics:Principal={...op,role:'analytics'};
 await upsertBindings(pool,workspace_id,[{text:'retention search',category:'Music',country:'BR',language:'pt',source_type:'MANUAL',source_ref:'test'}]);
 const {run}=await store.claimQueryRun(worker);assert.ok(run);
 const raw={bucket:'crawl-raw',key:`search/v1/${workspace_id}/${run.run_id}/${run.attempt}/page-1.json.gz`,sha256:'a'.repeat(64),bytes:100};
 await store.queryRunPage(worker,run.run_id,{attempt:run.attempt,page:1,items:[],raw_reference:raw});
 assert.deepEqual(await store.rawCleanupClaim(analytics),[]);
 await store.queryRunComplete(worker,run.run_id,{attempt:run.attempt,pages:1,stop_reason:'low_yield',channels:[],missing_channel_ids:[]});
 assert.deepEqual(await store.rawCleanupClaim(analytics),[]);
 await pool.query("UPDATE control.query_runs SET finished_at=clock_timestamp()-interval '25 hours',qualification_pending=1 WHERE run_id=$1",[run.run_id]);
 await pool.query('UPDATE telemetry.outbox SET archived_at=clock_timestamp() WHERE workspace_id=$1',[workspace_id]);
 assert.deepEqual(await store.rawCleanupClaim(analytics),[]);
 await pool.query('UPDATE control.query_runs SET qualification_pending=0 WHERE run_id=$1',[run.run_id]);
 const items=await store.rawCleanupClaim(analytics);assert.equal(items.length,1);assert.equal(items[0]!.kind,'SEARCH');assert.equal(items[0]!.key,raw.key);
});
