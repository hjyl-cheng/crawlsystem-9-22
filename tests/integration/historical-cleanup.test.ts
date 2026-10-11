import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {Store} from '@crawlsystem/store';
import {createPool} from '@crawlsystem/store/config';
import {fixtureSubmission} from '@crawlsystem/contracts/hash';
import {prepareDatabase} from './database-ready.ts';
import {assertRetired,cleanup,inventory,inventoryHash,isHistoricalTestWorkspace,type Selection} from '../../scripts/dev/e3-cleanup-lib.ts';

const pool=createPool(),store=new Store(pool);
before(async()=>{await prepareDatabase(pool);});after(async()=>{await pool.end();});
async function setup(workspace_id='test-'+randomUUID()){
 const p={workspace_id,subject:'e3-test',role:'operator' as const};
 const plan=await store.createPlan(p,{request_id:randomUUID(),fixture_id:'channel-basic-v1',required_domains:['ABOUT','VIDEO']});
 const input=await store.getInput(p,plan.plan_id);
 await store.apply({...p,role:'worker'},fixtureSubmission(input,'ABOUT'));await store.apply({...p,role:'worker'},fixtureSubmission(input,'VIDEO'));
 await pool.query("UPDATE control.plans SET deadline_at=clock_timestamp()-interval '2 days',updated_at=clock_timestamp()-interval '2 days' WHERE plan_id=$1",[plan.plan_id]);
 await pool.query('UPDATE telemetry.outbox SET archived_at=clock_timestamp() WHERE workspace_id=$1',[workspace_id]);
 return {p,plan,selection:{workspaces:[workspace_id],fixture_facts:false} satisfies Selection};
}
async function transaction(run:(db:PoolClient)=>Promise<void>){const db=await pool.connect();try{await db.query('BEGIN');await run(db);}finally{await db.query('ROLLBACK');db.release();}}

test('cleanup uses exact historical names and rejects live/unknown workspaces',()=>{
 assert.ok(isHistoricalTestWorkspace('test-query-'+randomUUID()));assert.ok(isHistoricalTestWorkspace('m1-execution-20260924'));
 for(const w of ['m1-main','console-e2e-3814487a386c','test-customer','test-'+randomUUID()+'-extra','customer-'+randomUUID()])assert.equal(isHistoricalTestWorkspace(w),false);
});

test('complete scoped cleanup follows actual foreign keys, retires expired work and preserves another workspace',async()=>{
 const t=await setup(),keep=await setup('protected-'+randomUUID());
 const query=await store.createQuery(t.p,{text:'historical cleanup',country:'BR',language:'pt',category:'Music'});
 await store.queryCommand(t.p,query.binding_id,{action:'disable',reason:'retired test',expected_version:1});
 const pending=await store.createPlan(t.p,{request_id:randomUUID(),fixture_id:'channel-basic-v1',required_domains:['ABOUT']});
 await pool.query("UPDATE control.plans SET deadline_at=clock_timestamp()-interval '2 days',updated_at=clock_timestamp()-interval '2 days' WHERE plan_id=$1",[pending.plan_id]);
 await pool.query('UPDATE telemetry.outbox SET archived_at=clock_timestamp() WHERE workspace_id=$1',[t.p.workspace_id]);
 await transaction(async db=>{
  const before=await inventory(db,t.selection);const result=await cleanup(db,t.selection,inventoryHash(before));
  assert.equal(result.removed['control.plans'],2);assert.equal(result.removed['control.receipts'],2);
  assert.equal(result.removed['control.query_sources'],1);assert.equal(result.removed['control.query_audit'],1);assert.equal(result.removed['control.query_terms'],1);
  assert.equal((await db.query('SELECT count(*)::int n FROM control.plans WHERE plan_id=$1',[keep.plan.plan_id])).rows[0].n,1);
  assert.equal((await db.query('SELECT count(*)::int n FROM crawl_data.videos WHERE workspace_id=$1',[keep.p.workspace_id])).rows[0].n,1);
 });
 assert.equal((await store.getPlan(t.p,t.plan.plan_id)).plan.status,'COMPLETED','Rollback restores selected records');
});

test('changed manifest, live deadlines, recent heartbeat and unarchived observations stop deletion',async()=>{
 const t=await setup();
 await transaction(async db=>{
  const hash=inventoryHash(await inventory(db,t.selection));
  await db.query('UPDATE crawl_data.videos SET source_revision=source_revision+1 WHERE workspace_id=$1',[t.p.workspace_id]);
  await assert.rejects(()=>cleanup(db,t.selection,hash),/manifest is stale/);
  await db.query("UPDATE control.plans SET deadline_at=clock_timestamp()+interval '1 hour' WHERE plan_id=$1",[t.plan.plan_id]);
  await assert.rejects(()=>assertRetired(db,t.selection),/unexpired plan/);
  await db.query("UPDATE control.plans SET deadline_at=clock_timestamp()-interval '2 days' WHERE plan_id=$1",[t.plan.plan_id]);
  await db.query("INSERT INTO control.workers(workspace_id,worker_id,heartbeat) VALUES($1,'e3-active','{}')",[t.p.workspace_id]);
  await assert.rejects(()=>assertRetired(db,t.selection),/worker heartbeat/);
  await db.query('DELETE FROM control.workers WHERE workspace_id=$1',[t.p.workspace_id]);
  await db.query('UPDATE telemetry.outbox SET archived_at=NULL WHERE workspace_id=$1',[t.p.workspace_id]);
  await assert.rejects(()=>assertRetired(db,t.selection),/Unarchived observation/);
 });
});

test('a foreign-key reference from a protected workspace blocks cascading cleanup',async()=>{
 const t=await setup(),keep=await setup('protected-'+randomUUID());
 await transaction(async db=>{
  await db.query('UPDATE control.channels SET latest_plan_id=$1 WHERE workspace_id=$2',[t.plan.plan_id,keep.p.workspace_id]);
  await assert.rejects(()=>assertRetired(db,t.selection),/Reference crosses cleanup boundary/);
  assert.equal((await db.query('SELECT count(*)::int n FROM control.plans WHERE plan_id=$1',[t.plan.plan_id])).rows[0].n,1);
 });
});

test('pending failure replays and pending publications preserve the test workspace',async()=>{
 const t=await setup();
 await transaction(async db=>{
  const f=(await db.query("INSERT INTO control.failures(workspace_id,signature,stage,code,state,plan_id) VALUES($1,'e3-test','WORKER','UNAVAILABLE','RESOLVED',$2) RETURNING failure_id",[t.p.workspace_id,t.plan.plan_id])).rows[0].failure_id;
  await db.query("INSERT INTO control.failure_replays(replay_id,workspace_id,failure_id,raw) VALUES($1,$2,$3,'{}')",[randomUUID(),t.p.workspace_id,f]);
  await db.query('UPDATE telemetry.outbox SET archived_at=clock_timestamp() WHERE workspace_id=$1',[t.p.workspace_id]);
  await assert.rejects(()=>assertRetired(db,t.selection),/Pending failure replay/);
  await db.query("UPDATE control.failure_replays SET state='DONE' WHERE failure_id=$1",[f]);
  await db.query("INSERT INTO delivery.targets(workspace_id,stream_id,name) VALUES($1,$2,'e3-test')",[t.p.workspace_id,randomUUID()]);
  await db.query("INSERT INTO delivery.records(delivery_id,workspace_id,channel_id,plan_id,revision,status) VALUES($1,$2,$3,$4,1,'PENDING')",[randomUUID(),t.p.workspace_id,t.plan.channel_id,t.plan.plan_id]);
  await assert.rejects(()=>assertRetired(db,t.selection),/Published test data/);
 });
});

test('fixed-fixture current facts can be removed while frozen plans and APPLIED identities survive',async()=>{
 const t=await setup('m1-main');
 await transaction(async db=>{
  const selection:Selection={workspaces:[],fixture_facts:true};
  const plans=(await db.query("SELECT plan_id FROM control.plans WHERE workspace_id='m1-main' ORDER BY 1")).rows;
  const receipts=(await db.query("SELECT submission_id FROM control.receipts WHERE workspace_id='m1-main' ORDER BY 1")).rows;
  await cleanup(db,selection,inventoryHash(await inventory(db,selection)));
  assert.equal((await db.query("SELECT count(*)::int n FROM crawl_data.videos WHERE workspace_id='m1-main' AND channel_id='fixture:channel:basic'")).rows[0].n,0);
  assert.deepEqual((await db.query("SELECT plan_id FROM control.plans WHERE workspace_id='m1-main' ORDER BY 1")).rows,plans);
  assert.deepEqual((await db.query("SELECT submission_id FROM control.receipts WHERE workspace_id='m1-main' ORDER BY 1")).rows,receipts);
  assert.equal((await db.query('SELECT status FROM control.plans WHERE plan_id=$1',[t.plan.plan_id])).rows[0].status,'COMPLETED');
 });
});
