import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPool} from '@crawlsystem/store/config';
import {ProxyStore} from '@crawlsystem/store/proxies';
import {proxyAvailability} from '../../packages/store/src/proxy-availability.ts';
import {ProxyAvailabilityQuerySchema} from '../../packages/contracts/src/proxy-availability.ts';
import {prepareDatabase} from './database-ready.ts';
const pool=createPool(),store=new ProxyStore(pool),spaces:string[]=[];
before(()=>prepareDatabase(pool));after(async()=>{await pool.query('DELETE FROM control.proxy_availability_hourly WHERE workspace_id=ANY($1::text[])',[spaces]);await pool.query('DELETE FROM control.proxies WHERE workspace_id=ANY($1::text[])',[spaces]);await pool.end();});
function people(){const workspace_id='d4-test-'+randomUUID();spaces.push(workspace_id);return {operator:{subject:'op',workspace_id,role:'operator' as const},reader:{subject:'rd',workspace_id,role:'reader' as const},node:{subject:'nd',workspace_id,role:'node' as const,server_id:'a1'}};}
async function proxy(p:ReturnType<typeof people>,host:string,provider='test-provider'){
  await store.importProxies(p.operator,{entries:[{protocol:'http',host,port:8080,username:null,password:null,provider,group:'test-group',kind:'static',country_code:null,max_concurrency:2}]});
  const x=(await store.overview(p.reader)).items.find(x=>x.host===host)!;return store.update(p.operator,x.proxy_id,{expected_version:x.version,server_id:'a1'});
}
const observation=(id:string,generation:number,state='healthy',requests=0,failures=0)=>({proxy_id:id,generation,state,requests_total:requests,failures_total:failures,cooldown_until:null,last_success_at:new Date().toISOString(),last_failure_at:null,last_error:null,latency_ms:20});
const report=(seq:number,observations:object[],boot='boot-test-a')=>({node_boot_id:boot,report_sequence:seq,observed_at:new Date().toISOString(),observations});
const query=(values:object={})=>ProxyAvailabilityQuerySchema.parse(values);
test('health observation ratios and weighted request success are independent; idle reports are real samples',async()=>{
  const p=people(),x=await proxy(p,'192.0.2.1'),y=await proxy(p,'192.0.2.2'),z=await proxy(p,'192.0.2.3');
  const samples=[observation(x.proxy_id,1,'healthy',100,2),observation(y.proxy_id,1,'trial'),observation(z.proxy_id,1,'degraded',1,1)];
  await store.sync(p.node,report(1,[...samples,samples[0]!,observation(x.proxy_id,1,'cooldown',999,900)]));let a=await store.availability(p.reader,query());
  assert.equal(a.summary.samples,3);assert.equal(a.summary.available_samples,2);assert.equal(a.summary.available_percent,66.67);assert.equal(a.summary.requests,101);assert.equal(a.summary.request_success_percent,97.03);
  assert.equal(a.points.filter(p=>p.counts.available_percent!==null).length,1);assert.equal(a.points.length,7);assert.equal(a.stale,false);
  await store.sync(p.node,report(2,samples));a=await store.availability(p.reader,query({resolution:'hour'}));assert.equal(a.summary.samples,6);assert.equal(a.summary.requests,101);assert.equal(a.points.length,24);
  assert.doesNotMatch(JSON.stringify(a),/192\.0\.2|password|username|credential/);
});
test('concurrent initial reports, duplicate sequences and superseded boots count only once',async()=>{
  const p=people(),x=await proxy(p,'192.0.2.4'),first=report(1,[observation(x.proxy_id,1,'healthy',10,1)]);
  await Promise.all([store.sync(p.node,first),store.sync(p.node,first)]);
  await store.sync(p.node,report(0,[observation(x.proxy_id,1,'healthy',30,2)]));
  await store.sync(p.node,report(1,[observation(x.proxy_id,1,'healthy',3,1)],'boot-test-b'));
  await store.sync(p.node,report(99,[observation(x.proxy_id,1,'cooldown',100,90)]));
  const a=await store.availability(p.reader,query());assert.equal(a.summary.samples,2);assert.equal(a.summary.requests,13);assert.equal(a.summary.failures,2);assert.equal(a.summary.cooldown,0);
  const latest=(await pool.query('SELECT node_boot_id,report_sequence FROM control.proxy_observations WHERE workspace_id=$1',[p.operator.workspace_id])).rows[0];assert.equal(latest.node_boot_id,'boot-test-b');
});
test('500 observations fit the node timeout; reverse-order concurrent duplicates cannot deadlock or inflate samples',async()=>{
  const p=people();
  const entries=Array.from({length:500},(_,i)=>({protocol:'http',host:`10.99.${i>>8}.${i&255}`,port:8080,username:null,password:null,provider:'capacity-test',group:'test-group',kind:'static',country_code:null,max_concurrency:2}));
  await store.importProxies(p.operator,{entries});
  await pool.query("UPDATE control.proxies SET server_id='a1',generation=1 WHERE workspace_id=$1",[p.operator.workspace_id]);
  const xs=(await store.overview(p.reader)).items.map(x=>observation(x.proxy_id,1,'healthy',10,1)),r=report(1,xs);
  const start=performance.now();assert.equal((await store.sync(p.node,r)).assignments.length,500);
  const elapsed=performance.now()-start;assert.ok(elapsed<8000,`500-observation sync took ${Math.round(elapsed)}ms`);
  await Promise.all([store.sync(p.node,report(2,xs)),store.sync(p.node,report(2,[...xs].reverse()))]);
  const a=await store.availability(p.reader,query());assert.equal(a.summary.samples,1000);assert.equal(a.summary.requests,5000);assert.equal(a.summary.failures,500);
  await Promise.all([store.importProxies(p.operator,{entries:[...entries].reverse()}),store.sync(p.node,report(3,xs))]);
  assert.equal((await store.availability(p.reader,query())).summary.samples,1500);
  console.log(`availability_500_sync_ms=${Math.round(elapsed)}`);
});
test('concurrent partial reports renew the complete server lease without deadlocks',async()=>{
  const p=people(),x=await proxy(p,'192.0.2.10'),y=await proxy(p,'192.0.2.11');
  const leases=await Promise.all([store.sync(p.node,report(1,[observation(x.proxy_id,1)])),store.sync(p.node,report(1,[observation(y.proxy_id,1)]))]);
  assert.ok(leases.every(l=>l.assignments.length===2));assert.equal((await store.availability(p.reader,query())).summary.samples,2);
});
test('old assignments, disabled proxies and stale or future reports cannot refresh health history',async()=>{
  const p=people(),x=await proxy(p,'192.0.2.5');
  await store.sync(p.node,{...report(1,[observation(x.proxy_id,1)]),observed_at:new Date(Date.now()-240000).toISOString()});
  await store.sync(p.node,{...report(2,[observation(x.proxy_id,1)]),observed_at:new Date(Date.now()+60000).toISOString()});
  assert.equal((await store.availability(p.reader,query())).summary.samples,0);assert.equal((await store.overview(p.reader)).items[0]!.state,'unknown');
  const moved=await store.update(p.operator,x.proxy_id,{expected_version:x.version,server_id:'a2'});
  await store.sync(p.node,report(3,[observation(x.proxy_id,1)]));
  await store.sync({...p.node,server_id:'a2'},report(1,[observation(x.proxy_id,2)],'boot-test-c'));
  const disabled=await store.update(p.operator,x.proxy_id,{expected_version:moved.version,enabled:false});
  await store.sync({...p.node,server_id:'a2'},report(2,[observation(x.proxy_id,2)],'boot-test-c'));
  assert.equal((await store.availability(p.reader,query())).summary.samples,1);assert.equal(disabled.enabled,false);
});
test('workspace, provider and server filters are bound to the caller; reader is allowed and machine identities are refused',async()=>{
  const p=people(),x=await proxy(p,'192.0.2.6','one'),y=await proxy(p,'192.0.2.7','two');
  await store.sync(p.node,report(1,[observation(x.proxy_id,1),observation(y.proxy_id,1,'trial')]));
  assert.equal((await store.availability(p.reader,query({provider:'one',server_id:'a1'}))).summary.available_percent,100);
  assert.equal((await store.availability(p.reader,query({provider:'two'}))).summary.available_percent,0);
  const absent=await store.availability(p.reader,query({server_id:'a2'}));assert.equal(absent.summary.available_percent,null);assert.equal(absent.latest_report_at,null);assert.equal(absent.stale,true);
  assert.equal((await store.availability({...p.reader,workspace_id:'unrelated'},query())).summary.samples,0);
  for(const role of ['node','worker'] as const)await assert.rejects(()=>store.availability({...p.reader,role},query()),(e:unknown)=>(e as {code:string}).code==='FORBIDDEN');
  await pool.query("UPDATE control.proxy_availability_hourly SET first_report_at=clock_timestamp()-interval '5 minutes',last_report_at=clock_timestamp()-interval '4 minutes' WHERE workspace_id=$1",[p.operator.workspace_id]);
  const offline=await store.availability(p.reader,query());assert.equal(offline.stale,true);assert.equal(offline.summary.samples,2);assert.equal(offline.summary.available_percent,50);
});
async function insert(workspace:string,at:string,healthy:number,trial:number,requests:number,failures:number){
  await pool.query(`INSERT INTO control.proxy_availability_hourly(workspace_id,bucket_at,server_id,provider,group_name,healthy,trial,requests,failures,first_report_at,last_report_at)
    VALUES($1,$2,'a1','historical','g',$3,$4,$5,$6,$2::timestamptz+interval '1 minute',$2::timestamptz+interval '2 minutes')`,[workspace,at,healthy,trial,requests,failures]);
}
test('Shanghai day boundaries include current-day hours, omit future buckets and leave missing hours empty',async()=>{
  const p=people(),now=new Date('2026-10-11T01:30:00Z');
  await insert(p.operator.workspace_id,'2026-10-10T15:00:00Z',1,0,2,0); // 23:00 previous local day
  await insert(p.operator.workspace_id,'2026-10-10T16:00:00Z',0,1,3,2); // 00:00 current local day
  await insert(p.operator.workspace_id,'2026-10-11T01:00:00Z',1,0,5,1); // current 09:00 hour
  await insert(p.operator.workspace_id,'2026-10-11T02:00:00Z',20,0,100,0); // future; excluded
  const day=await proxyAvailability(pool,p.operator.workspace_id,query(),now);assert.equal(day.summary.samples,3);assert.equal(day.points.at(-1)!.counts.samples,2);assert.equal(day.points.at(-2)!.counts.samples,1);assert.equal(day.points[0]!.counts.available_percent,null);
  const hour=await proxyAvailability(pool,p.operator.workspace_id,query({resolution:'hour'}),now);assert.equal(hour.summary.requests,10);assert.equal(hour.points.at(-1)!.counts.requests,5);assert.equal(hour.points.at(-2)!.counts.available_percent,null);
});
test('range totals use sample and request weights; history survives endpoint deletion',async()=>{
  const p=people(),x=await proxy(p,'192.0.2.8');
  await store.sync(p.node,report(1,[observation(x.proxy_id,1,'healthy',10,2)]));
  const disabled=await store.update(p.operator,x.proxy_id,{expected_version:x.version,enabled:false});await store.remove(p.operator,x.proxy_id,disabled.version);
  assert.equal((await store.availability(p.reader,query())).summary.samples,1);
  const other=people(),now=new Date('2026-10-11T01:30:00Z');await insert(other.operator.workspace_id,'2026-10-10T15:00:00Z',1,9,100,10);await insert(other.operator.workspace_id,'2026-10-11T01:00:00Z',100,0,1,0);
  const a=await proxyAvailability(pool,other.operator.workspace_id,query(),now);assert.equal(a.summary.available_percent,91.82);assert.equal(a.summary.request_success_percent,90.1);
});
test('retention removes old buckets and contradictory request deltas show no false success percentage',async()=>{
  const p=people(),x=await proxy(p,'192.0.2.9');await insert(p.operator.workspace_id,new Date(Date.now()-11*86400000).toISOString(),1,0,1,0);
  await store.sync(p.node,report(1,[observation(x.proxy_id,1,'healthy',10,0)]));await store.sync(p.node,report(2,[observation(x.proxy_id,1,'healthy',10,1)]));
  assert.equal((await pool.query('SELECT count(*)::int n FROM control.proxy_availability_hourly WHERE workspace_id=$1',[p.operator.workspace_id])).rows[0].n,1);
  await pool.query('UPDATE control.proxy_availability_hourly SET requests=0,failures=1 WHERE workspace_id=$1',[p.operator.workspace_id]);
  const a=await store.availability(p.reader,query());assert.equal(a.summary.request_success_percent,null);assert.equal(a.summary.available_percent,100);
});
