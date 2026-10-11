import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPool} from '@crawlsystem/store/config';
import {Store} from '@crawlsystem/store';
import {ProxyStore} from '@crawlsystem/store/proxies';
import {issueToken} from '@crawlsystem/http/auth';
import {createControlApi} from '../../apps/control-api/src/app.ts';
import {collectQueries,collectionSummary} from '../../packages/store/src/query-collection.ts';
import {QueryCollectionLimitsSchema,type QueryCollectionLimits} from '../../packages/contracts/src/configuration.ts';
import {prepareDatabase} from './database-ready.ts';
const pool=createPool(),store=new Store(pool),key=new Uint8Array(32).fill(21),app=createControlApi({store,signingKey:key,proxies:new ProxyStore(pool)});
const limits=QueryCollectionLimitsSchema.parse({}),now=new Date('2026-10-11T08:00:00Z');
const workspace=()=>`b2-test-${randomUUID()}`;
before(async()=>{await prepareDatabase(pool);await app.ready();});after(async()=>{await app.close();await pool.end();});
async function run(ws:string,settings:QueryCollectionLimits=limits,at=now){const c=await pool.connect();try{await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='5s';SET LOCAL transaction_timeout='10s'");const r=await collectQueries(c,ws,settings,at);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
async function channel(ws:string,keywords=['free fire'],country='Brazil',category='Gaming',id='UC'+randomUUID().replaceAll('-','').slice(0,22)){
  const plan=randomUUID();
  const r=await pool.query(`INSERT INTO control.plans(plan_id,run_id,workspace_id,request_id,request_hash,channel_id,source_mode,fixture_id,required_domains,status,frozen_input,input_hash,workflow_id,finished_at,deadline_at)
    VALUES($1::uuid,$2,$3,$4,'test',$5,'youtube',NULL,ARRAY['ABOUT','AGENT'],'COMPLETED','{}','test',($1::uuid)::text,$6::timestamptz,$6::timestamptz+interval '1 day') RETURNING source_revision`,[plan,randomUUID(),ws,randomUUID(),id,now]);
  await pool.query(`INSERT INTO control.channels(workspace_id,channel_id,latest_plan_id,latest_plan_revision,management_state) VALUES($1,$2,$3,$4,'managed')
    ON CONFLICT(workspace_id,channel_id) DO UPDATE SET latest_plan_id=$3,latest_plan_revision=$4`,[ws,id,plan,r.rows[0].source_revision]);
  const fact=(value:unknown)=>({value,confidence:'high'});
  await pool.query(`INSERT INTO crawl_data.channels(workspace_id,channel_id,about,agent) VALUES($1,$2,$3,$4)
    ON CONFLICT(workspace_id,channel_id) DO UPDATE SET about=$3,agent=$4`,[ws,id,{keywords},{facts:{country:fact(country),creator_language:fact('Portuguese'),channel_categories:fact({level_1:category}),channel_tags:fact({tags:[]})}}]);return id;
}
const op=(ws:string)=>({workspace_id:ws,subject:'b2-operator',role:'operator' as const});
test('distinct channel support, incremental replay and country/category/workspace isolation',async()=>{
  const ws=workspace(),id=await channel(ws);assert.equal((await run(ws)).created,0);
  await channel(ws,['free fire'],'Brazil','Gaming',id);await run(ws);
  assert.equal((await collectionSummary(pool,ws,limits,now)).waiting_support,1);
  await channel(ws,['free fire'],'Mexico');await channel(ws,['free fire'],'Brazil','Music');await channel(workspace());
  assert.equal((await run(ws)).created,0);
  await channel(ws);assert.equal((await run(ws)).created,1);
  const q=(await store.queries(op(ws))).items;assert.equal(q.length,1);assert.equal(q[0]!.priority,-10);assert.equal(q[0]!.state,'BOOTSTRAP');assert.equal(q[0]!.source_count,2);
  assert.deepEqual(await run(ws),{scanned:0,created:0,woken:0});
  const sources=await store.querySources(op(ws),q[0]!.binding_id);assert.equal(sources.items.length,2);assert.ok(sources.items.every(s=>s.channel_id));
});
test('concurrent rounds respect daily and total limits and preserve eligible candidates for later',async()=>{
  const ws=workspace();await channel(ws,['free fire','jogos brasileiros','campeonato apostado']);await channel(ws,['free fire','jogos brasileiros','campeonato apostado']);
  const small={...limits,daily_binding_limit:1,max_auto_bindings:2};
  const r=await Promise.all([run(ws,small),run(ws,small)]);assert.equal(r.reduce((n,v)=>n+v.created,0),1);
  let s=await collectionSummary(pool,ws,small,now);assert.equal(s.created_today,1);assert.equal(s.waiting_promotion,2);assert.equal(s.limited,'daily');
  await run(ws,small,new Date('2026-10-12T08:00:00Z'));s=await collectionSummary(pool,ws,small,new Date('2026-10-13T08:00:00Z'));
  assert.equal(s.auto_bindings,2);assert.equal(s.waiting_promotion,1);assert.equal(s.limited,'total');assert.equal((await run(ws,small,new Date('2026-10-13T08:00:00Z'))).created,0);
});
test('automatic provenance keeps disabled bindings disabled and preserves manual cadence and scheduling',async()=>{
  const ws=workspace(),p=op(ws);const q=await store.createQuery(p,{text:'free fire',country:'BR',language:'pt',category:'Gaming'});
  let b=await store.queryCommand(p,q.binding_id,{action:'set_cadence',cadence:'WEEK',reason:'manual',expected_version:1});
  b=await store.queryCommand(p,q.binding_id,{action:'disable',reason:'manual',expected_version:b.version});
  await channel(ws);await channel(ws);const r=await run(ws);assert.equal(r.created,0);assert.equal(r.woken,0);
  const after=(await store.queries(p)).items[0]!;assert.equal(after.state,'DISABLED');assert.equal(after.cadence_override,'WEEK');assert.equal(after.version,b.version);assert.equal(after.next_run_at,null);assert.equal(after.source_count,3);
});
test('a dormant binding wakes only for new distinct-channel evidence and retains its override',async()=>{
  const ws=workspace(),p=op(ws);await channel(ws);await channel(ws);await run(ws);
  const q=(await store.queries(p)).items[0]!;
  await pool.query("UPDATE control.query_bindings SET state='DORMANT',next_run_at=NULL,last_success_at=$2,cadence_override='WEEK' WHERE binding_id=$1",[q.binding_id,now]);
  assert.equal((await run(ws)).woken,0);
  await channel(ws);assert.equal((await run(ws)).woken,1);
  let b=(await store.queries(p)).items[0]!;assert.equal(b.state,'ACTIVE');assert.equal(b.cadence_override,'WEEK');assert.equal(b.version,2);
  await pool.query("UPDATE control.query_bindings SET state='DORMANT',next_run_at=NULL WHERE binding_id=$1",[q.binding_id]);await run(ws);b=(await store.queries(p)).items[0]!;assert.equal(b.state,'DORMANT');
  assert.equal((await pool.query("SELECT count(*)::int n FROM control.query_audit WHERE binding_id=$1 AND action='auto_wake'",[q.binding_id])).rows[0].n,1);
});
test('stopped collection does no work; a zero daily budget retains support and later adds the binding',async()=>{
  const ws=workspace();await channel(ws);await channel(ws);
  assert.deepEqual(await run(ws,{...limits,enabled:false}),{scanned:0,created:0,woken:0});
  await run(ws,{...limits,daily_binding_limit:0});assert.equal((await collectionSummary(pool,ws,limits,now)).waiting_promotion,1);
  assert.equal((await run(ws)).created,1);
});
test('the same channel supplies one evidence row and candidates retain at most five channel sources',async()=>{
  const ws=workspace();for(let i=0;i<7;i++)await channel(ws);await run(ws);
  const c=(await pool.query('SELECT support_count FROM control.query_collection_candidates WHERE workspace_id=$1',[ws])).rows[0];assert.equal(c.support_count,5);
  assert.equal((await store.queries(op(ws))).items[0]!.source_count,5);
});
test('unmapped and incomplete/non-managed collection never feed the search queue',async()=>{
  const ws=workspace();await channel(ws,['free fire'],'Atlantis');const paused=await channel(ws);const failed=await channel(ws);const fixture=await channel(ws);
  await pool.query("UPDATE control.channels SET management_state='paused' WHERE workspace_id=$1 AND channel_id=$2",[ws,paused]);
  await pool.query("UPDATE control.plans SET status='FAILED' WHERE workspace_id=$1 AND channel_id=$2",[ws,failed]);
  await pool.query("UPDATE control.plans SET source_mode='fixture',fixture_id='test' WHERE workspace_id=$1 AND channel_id=$2",[ws,fixture]);
  assert.equal((await run(ws)).scanned,1);assert.equal((await collectionSummary(pool,ws,limits,now)).skipped_channels,1);assert.equal((await store.queries(op(ws))).items.length,0);
});
test('collection and sources enforce human roles, strict query parameters and workspace isolation',async()=>{
  const ws=workspace();await channel(ws);await channel(ws);await run(ws);const id=(await store.queries(op(ws))).items[0]!.binding_id;
  const get=async(role:string,url:string,space=ws)=>app.inject({method:'GET',url,headers:{authorization:'Bearer '+await issueToken({subject:'b2-test',workspace_id:space,role:role as 'reader'},key)}});
  for(const role of ['reader','operator','worker','node'])for(const url of ['/v1/queries/collection',`/v1/queries/${id}/sources`])assert.equal((await get(role,url)).statusCode,['reader','operator'].includes(role)?200:403);
  assert.equal((await get('reader','/v1/queries/collection?workspace_id=other')).statusCode,400);
  assert.equal((await get('reader',`/v1/queries/${id}/sources?unknown=x`)).statusCode,400);
  assert.equal((await get('reader',`/v1/queries/${id}/sources`,workspace())).statusCode,404);
  assert.equal((await get('reader','/v1/queries/collection',workspace())).json().candidates,0);
});
test('candidate capacity is bounded while already recorded candidates keep gaining support',async()=>{
  const ws=workspace();
  await pool.query(`INSERT INTO control.query_collection_candidates(workspace_id,text,country,language,category,created_at,updated_at)
    SELECT $1,'holding '||n,'BR','pt','Gaming',$2,$2 FROM generate_series(1,19999) n`,[ws,now]);
  await channel(ws,['free fire','jogos brasileiros']);await channel(ws,['free fire']);await run(ws);
  const s=await collectionSummary(pool,ws,limits,now);assert.equal(s.candidates,20000);assert.equal(s.auto_bindings,1);assert.equal(s.limited,'candidates');assert.equal(s.skipped_channels,1);
});
test('failed rounds roll back scan ledger, provenance, created bindings and budgets together',async()=>{
  const ws=workspace();await channel(ws);await channel(ws);const c=await pool.connect();
  try{await c.query('BEGIN');assert.equal((await collectQueries(c,ws,limits,now)).created,1);await c.query('ROLLBACK');}finally{c.release();}
  const s=await collectionSummary(pool,ws,limits,now);assert.equal(s.candidates,0);assert.equal(s.scanned_channels,0);assert.equal(s.created_today,0);assert.equal((await store.queries(op(ws))).items.length,0);
  assert.equal((await run(ws)).created,1);
});
test('published collection settings control the dispatcher and promoted words use the existing first-year search lease',async()=>{
  const ws=workspace(),p=op(ws);await channel(ws);await channel(ws);let version=0;
  const publish=async(key:string,value:unknown)=>{await store.publishConfig(p,{command_id:randomUUID(),expected_version:version++,key,value,reason:'B2 settings verification',confirm_risk:true});};
  await publish('query_collection.enabled',false);assert.equal((await store.collectQueries(ws)).scanned,0);
  await publish('query_collection.min_support_channels',3);await publish('query_collection.enabled',true);
  assert.equal((await store.collectQueries(ws)).created,0);await channel(ws);assert.equal((await store.collectQueries(ws)).created,1);
  const claim=await store.claimQueryRun({...p,subject:'b2-worker',role:'worker'});assert.ok(claim.run);assert.equal(claim.run.params.window,'THIS_YEAR');assert.equal(claim.run.params.text,'free fire');assert.equal(claim.run.params.country,'BR');
});
