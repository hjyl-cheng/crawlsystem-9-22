import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '@crawlsystem/store';
import { createPool } from '@crawlsystem/store/config';
import type {Principal} from '@crawlsystem/contracts';
import type {HandleResolver} from '../../packages/store/src/handle-import.ts';
import { prepareDatabase } from './database-ready.ts';
const pool=createPool();assert.notEqual(new URL(process.env.DATABASE_URL!).pathname,'/crawlsystem_m1_main_test');
before(async()=>prepareDatabase(pool));after(async()=>pool.end());
function setup(resolver:HandleResolver,limits={}){const workspace_id='handle-'+randomUUID(),op:Principal={workspace_id,subject:'test',role:'operator'};return {op,store:new Store(pool,limits as never,undefined,{resolveHandle:resolver}),request:(lines:string[])=>({request_id:randomUUID(),lines})};}
test('handles, URLs, aliases and canonical IDs share one queue; cached resolution consumes no extra quota',async()=>{
 const id='UC'+randomUUID().replaceAll('-','').slice(0,22);let calls=0;
 const t=setup(async(_h,g)=>{calls++;await g.permit('channels');return id;});
 const result=await t.store.importChannels(t.op,t.request(['@Creator','https://www.youtube.com/@creator',id]));
 assert.deepEqual(result.items.map(i=>i.outcome),['queued','duplicate','duplicate']);assert.equal(result.queued,1);assert.equal(calls,1);
 assert.equal((await t.store.importChannels(t.op,t.request(['@CREATOR']))).items[0]!.outcome,'already_queued');assert.equal(calls,1);
 assert.equal((await pool.query('SELECT used_units FROM control.data_api_budget WHERE workspace_id=$1',[t.op.workspace_id])).rows[0].used_units,1);
 assert.equal((await pool.query('SELECT count(*)::int n FROM control.data_api_permits WHERE workspace_id=$1 AND import_request_id IS NOT NULL',[t.op.workspace_id])).rows[0].n,1);
 await assert.rejects(()=>t.store.importChannels({...t.op,role:'reader'},t.request(['@othercreator'])));assert.equal(calls,1);
});
test('Unicode handles and encoded YouTube links normalize to the same identity',async()=>{
 const id='UC'+randomUUID().replaceAll('-','').slice(0,22);let calls=0;
 const t=setup(async(h,g)=>{assert.equal(h,'@频道名称');await g.permit('channels');calls++;return id;});
 const r=await t.store.importChannels(t.op,t.request(['@频道名称','https://www.youtube.com/'+encodeURIComponent('@频道名称')]));assert.deepEqual(r.items.map(i=>i.outcome),['queued','duplicate']);assert.equal(calls,1);
});
test('official absence is cached; transient failure is retryable and does not poison the resolution cache',async()=>{
 let calls=0;const t=setup(async(h,g)=>{calls++;const permit=await g.permit('channels');if(h==='@missing')return null;await g.failed!(permit,'channels',{kind:'unavailable'});throw new Error('transient');});
 const first=await t.store.importChannels(t.op,t.request(['@missing','@network']));assert.deepEqual(first.items.map(i=>i.outcome),['handle_not_found','resolution_unavailable']);
 await t.store.importChannels(t.op,t.request(['@missing','@network']));assert.equal(calls,3);
 assert.equal((await pool.query('SELECT count(*)::int n FROM control.data_api_permits WHERE workspace_id=$1 AND failure IS NOT NULL',[t.op.workspace_id])).rows[0].n,2);
});
test('concurrent resolution respects the shared daily limit and preserves canonical imports when quota is exhausted',async()=>{
 const id='UC'+randomUUID().replaceAll('-','').slice(0,22);let fetched=0;
 const t=setup(async(_h,g)=>{await g.permit('channels');fetched++;return id;},{api_daily_limit:1});
 const result=await t.store.importChannels(t.op,t.request(['@first','@second','@third',id]));
 assert.equal(fetched,1);assert.equal(result.items.filter(i=>i.outcome==='quota_exhausted').length,2);assert.equal(result.queued,1);
 assert.equal((await pool.query('SELECT used_units FROM control.data_api_budget WHERE workspace_id=$1',[t.op.workspace_id])).rows[0].used_units,1);
});
