import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import type {Store} from '@crawlsystem/store';
import {issueToken} from '@crawlsystem/http/auth';
import {Prometheus} from '../src/monitoring.ts';
import {readStorageCapacity,storageQueries} from '../src/storage-capacity.ts';
import {createControlApi} from '../src/app.ts';
const now=Date.now(),buckets=['crawl-raw','crawl-parsed','crawl-evidence'];
type Sample={labels:Record<string,string>;value:number};
function samples(overrides:Partial<Record<keyof typeof storageQueries,Sample[]>>={}){
  const values={up:['minio-cluster','minio-buckets'].map(job=>({labels:{job},value:1})),sampled:[{labels:{},value:now/1000-30}],
    usage:buckets.map((bucket,i)=>({labels:{bucket},value:[0,70,85][i]!})),quota:buckets.map(bucket=>({labels:{bucket},value:100})),objects:buckets.map(bucket=>({labels:{bucket},value:0})),
    scan:[{labels:{},value:30}],free:[{labels:{},value:400}],total:[{labels:{},value:1000}],...overrides};
  return async(q:string)=>values[(Object.keys(storageQueries) as (keyof typeof storageQueries)[]).find(k=>storageQueries[k]===q)!];
}
test('capacity treats empty buckets as valid and uses live quotas at the 70/85 thresholds',async()=>{
 const r=await readStorageCapacity(samples(),now);assert.equal(r.available,true);assert.deepEqual(r.buckets.map(b=>b.state),['ok','warning','critical']);
 assert.equal(r.buckets[0]!.used_bytes,0);assert.equal(r.buckets[0]!.remaining_bytes,100);assert.equal(r.buckets[0]!.objects,0);
 const over=await readStorageCapacity(samples({usage:buckets.map(bucket=>({labels:{bucket},value:120}))}),now);
 assert.equal(over.buckets[0]!.remaining_bytes,0);assert.equal(over.buckets[0]!.used_percent,120);
});
test('missing or invalid metrics cannot manufacture free space, including a missing single bucket',async()=>{
 for(const value of [NaN,Infinity,-1,1.1,Number.MAX_SAFE_INTEGER+1]){
  const r=await readStorageCapacity(samples({usage:[{labels:{bucket:'crawl-raw'},value}]}),now);assert.equal(r.available,false);assert.equal(r.buckets[0]!.used_bytes,null);
 }
 for(const override of [{quota:[]},{quota:buckets.map(bucket=>({labels:{bucket},value:0}))},{objects:[]},{scan:[]},{scan:[{labels:{},value:21601}]}]){
  const r=await readStorageCapacity(samples(override),now);assert.equal(r.available,false);assert.ok(r.buckets.every(b=>b.state==='unknown'&&b.remaining_bytes===null));
 }
 const partial=await readStorageCapacity(samples({usage:[{labels:{bucket:'crawl-raw'},value:1}]}),now);assert.equal(partial.buckets[0]!.state,'ok');assert.equal(partial.buckets[1]!.state,'unknown');
 const disk=await readStorageCapacity(samples({free:[{labels:{},value:1001}]}),now);assert.equal(disk.available,false);assert.equal(disk.disk.free_bytes,null);
});
test('stopped scrapes and stale or future samples suppress cached numeric usage',async()=>{
 for(const override of [{up:[]},{up:[{labels:{job:'minio-cluster'},value:1},{labels:{job:'minio-buckets'},value:0}]},{sampled:[{labels:{},value:now/1000-121}]},{sampled:[{labels:{},value:now/1000+10}]}]){
  const r=await readStorageCapacity(samples(override),now);assert.equal(r.available,false);assert.equal(r.sampled_at,null);assert.ok(r.buckets.every(b=>b.used_percent===null));
 }
});
test('Prometheus capacity reader rejects malformed, oversized and failed responses',async()=>{
 for(const response of [()=>new Response('unavailable',{status:503}),()=>new Response('x'.repeat(1048577)),()=>new Response(JSON.stringify({status:'success',data:{resultType:'matrix',result:[]}}))]){
  await assert.rejects(new Prometheus('http://monitor.test',async()=>response()).storageCapacity(now));
 }
});
test('capacity API scopes physical metrics, denies workloads and coalesces concurrent refreshes',async()=>{
 const key=randomBytes(32);let calls=0;
 const monitoring={storageCapacity:async()=>{calls++;return readStorageCapacity(samples(),now);}} as unknown as Prometheus;
 const app=createControlApi({store:{} as Store,signingKey:key,monitoring,metricsWorkspace:'tenant-a'});
 const headers=async(role:'reader'|'operator'|'node'|'worker',workspace_id='tenant-a')=>({authorization:'Bearer '+await issueToken({subject:'capacity-'+role,role,workspace_id},key)});
 try{
  const h=await headers('reader');const [one,two]=await Promise.all([app.inject({url:'/v1/storage/capacity',headers:h}),app.inject({url:'/v1/storage/capacity',headers:h})]);
  assert.equal(one.statusCode,200);assert.equal(two.json().available,true);assert.equal(calls,1);
  assert.equal((await app.inject({url:'/v1/storage/capacity',headers:await headers('operator')})).json().available,true);assert.equal(calls,1);
  const other=await app.inject({url:'/v1/storage/capacity',headers:await headers('reader','tenant-b')});assert.equal(other.json().available,false);assert.equal(other.json().disk.total_bytes,null);assert.equal(calls,1);
  assert.equal((await app.inject({url:'/v1/storage/capacity?bucket=other',headers:h})).statusCode,400);
  for(const role of ['node','worker'] as const)assert.equal((await app.inject({url:'/v1/storage/capacity',headers:await headers(role)})).statusCode,403);
 }finally{await app.close();}
});
test('capacity outage leaves the original storage API usable and hides dependency errors',async()=>{
 const key=randomBytes(32),monitoring=new Prometheus('http://monitor.test',async()=>{throw new Error('private dependency address');});
 const app=createControlApi({store:{storage:async()=>({original:true})} as unknown as Store,signingKey:key,monitoring,metricsWorkspace:'tenant-a'});
 const headers={authorization:'Bearer '+await issueToken({subject:'capacity-reader',role:'reader',workspace_id:'tenant-a'},key)};
 try{const r=await app.inject({url:'/v1/storage/capacity',headers});assert.equal(r.statusCode,200);assert.equal(r.json().available,false);assert.doesNotMatch(r.body,/private dependency/);assert.equal((await app.inject({url:'/v1/storage',headers})).json().original,true);}
 finally{await app.close();}
});
