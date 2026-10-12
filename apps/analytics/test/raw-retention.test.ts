import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {cleanRawBatch} from '../src/raw-retention.ts';
import type {RawCleanupItem} from '../../../packages/contracts/src/raw-retention.ts';
const plan=randomUUID(),base=`v1/m1-main/${plan}/1/ABOUT/`;
const item=():RawCleanupItem=>({workspace_id:'m1-main',plan_id:plan,run_id:null,execution_epoch:1,kind:'UNIT',key:base+'channel.json.gz',lease_token:randomUUID(),expected_bytes:100,
 required_refs:[{bucket:'crawl-parsed',key:base+'channel.youtube-raw-1.'+'a'.repeat(64)+'.json.gz',bytes:10,sha256:'b'.repeat(64)}]});
test('deletes only raw after checking durable parsed references; missing parsed/comments veto deletion',async()=>{
 let rawExists=true;const calls:string[]=[];
 const raw={head:async()=>rawExists?100:null,remove:async(key:string)=>{calls.push(key);rawExists=false;}};
 const good=await cleanRawBatch([item()],raw,{head:async()=>10});assert.equal(good[0]!.outcome,'DELETED');assert.equal(good[0]!.bytes,100);assert.deepEqual(calls,[item().key]);
 assert.equal((await cleanRawBatch([item()],raw,{head:async()=>10}))[0]!.outcome,'MISSING');
 rawExists=true;calls.length=0;
 assert.equal((await cleanRawBatch([item()],raw,{head:async()=>null}))[0]!.error,'PARSED_MISSING');assert.equal(calls.length,0);
 const comment:RawCleanupItem={...item(),required_refs:[...item().required_refs,{bucket:'crawl-parsed',key:`v1/m1-main/${plan}/1/comments/video.${'a'.repeat(64)}.json.gz`,bytes:5,sha256:'c'.repeat(64)}]};
 assert.equal((await cleanRawBatch([comment],raw,{head:async key=>key.includes('/comments/')?null:10}))[0]!.error,'PARSED_MISSING');assert.equal(calls.length,0);
});
test('rejects foreign owners, unknown prefixes, traversal and size changes',async()=>{
 let removed=0;const raw={head:async()=>100,remove:async()=>{removed++;}},parsed={head:async()=>10};
 for(const key of ['v1/other/private.json.gz','failures/v1/m1-main/private.json.gz',base+'../secret.json.gz',base+'channel.json.gz/extra']) {
  assert.equal((await cleanRawBatch([{...item(),key}],raw,parsed))[0]!.error,'INVALID_KEY');
 }
 assert.equal((await cleanRawBatch([{...item(),required_refs:[{...item().required_refs[0]!,bucket:'crawl-evidence'}]}],raw,parsed))[0]!.error,'INVALID_KEY');
 assert.equal((await cleanRawBatch([{...item(),expected_bytes:99}],raw,parsed))[0]!.error,'INTEGRITY');assert.equal(removed,0);
});
test('partial storage failure preserves failed objects and retries are idempotent',async()=>{
 const a=item(),b={...item(),key:base+'video.json.gz'},existing=new Set([a.key,b.key]);let fail=true;
 const raw={head:async(key:string)=>existing.has(key)?100:null,remove:async(key:string)=>{if(key===a.key&&fail)throw new Error('offline');existing.delete(key);}};
 const first=await cleanRawBatch([a,b],raw,{head:async()=>10});assert.equal(first.find(r=>r.key===a.key)!.outcome,'ERROR');assert.equal(first.find(r=>r.key===b.key)!.outcome,'DELETED');
 fail=false;const retry=await cleanRawBatch([a,b],raw,{head:async()=>10});assert.equal(retry.find(r=>r.key===a.key)!.outcome,'DELETED');assert.equal(retry.find(r=>r.key===b.key)!.outcome,'MISSING');
 assert.equal((await cleanRawBatch([item()],{head:async()=>100,remove:async()=>{}},{head:async()=>10}))[0]!.outcome,'ERROR');
});
test('search deletion only accepts the successful page key form and aborted batches leave leases untouched',async()=>{
 const run=randomUUID(),search={...item(),kind:'SEARCH' as const,plan_id:null,run_id:run,execution_epoch:null,key:`search/v1/m1-main/${run}/1/page-1.json.gz`,required_refs:[]};
 let exists=true;const raw={head:async()=>exists?100:null,remove:async()=>{exists=false;}};
 assert.equal((await cleanRawBatch([search],raw,{head:async()=>null}))[0]!.outcome,'DELETED');
 assert.deepEqual(await cleanRawBatch([item()],raw,{head:async()=>10},AbortSignal.abort()),[]);
});
