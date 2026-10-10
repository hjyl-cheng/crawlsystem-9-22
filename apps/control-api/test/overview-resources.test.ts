import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import type {Store} from '@crawlsystem/store';
import type {ProxyStore} from '@crawlsystem/store/proxies';
import {issueToken} from '@crawlsystem/http/auth';
import {Prometheus} from '../src/monitoring.ts';
import {createControlApi} from '../src/app.ts';
const now=Date.now();
const monitoring=(stale=false,down=false)=>new Prometheus('http://monitor.test',async input=>{
 const query=new URL(String(input)).searchParams.get('query')!;
 const value=query.includes('timestamp(')?now/1000-(stale?180:20):query.includes('rate(')?12.5:query.includes('MemAvailable')?1024:query.includes('MemTotal')?4096:down?0:1;
 return new Response(JSON.stringify({status:'success',data:{resultType:'vector',result:['a1','a2'].map(node=>({metric:{node},value:[now/1000,String(value)]}))}}));
});
test('monitoring returns only registered nodes and withholds stale or stopped exporter samples',async()=>{
 const nodes=await monitoring().nodes(['crawl-a1'],now);assert.equal(nodes.length,1);assert.equal(nodes[0]!.server_id,'crawl-a1');assert.equal(nodes[0]!.cpu_percent,12.5);assert.equal(nodes[0]!.memory_used_bytes,3072);
 for(const client of [monitoring(true),monitoring(false,true)]){const r=(await client.nodes(['a1'],now))[0]!;assert.equal(r.sampled_at,null);assert.equal(r.cpu_percent,null);assert.equal(r.memory_used_bytes,null);}
});
test('resource API keeps tenant inventory usable during a monitoring outage and denies workloads',async()=>{
 const key=randomBytes(32),calls:string[]=[];
 const store={listWorkers:async(p:{workspace_id:string})=>{calls.push(p.workspace_id);return {items:[{server_id:'a1'}],next_cursor:null};}} as unknown as Store;
 const ips={total:5,by_state:{healthy:2,trial:0,degraded:0,cooldown:0,failed:0,disabled:1,unassigned:1,unknown:1},assignments:[{server_id:'a1',assigned:3}]};
 const proxies={resources:async(p:{workspace_id:string})=>{calls.push(p.workspace_id);return ips;}} as unknown as ProxyStore;
 const down=new Prometheus('http://monitor.test',async()=>{throw new Error('dependency failed');});
 const app=createControlApi({store,proxies,signingKey:key,monitoring:down});
 try{
  const headers={authorization:`Bearer ${await issueToken({subject:'resource-reader',workspace_id:'tenant-a',role:'reader'},key)}`};
  const response=await app.inject({url:'/v1/overview/resources',headers});assert.equal(response.statusCode,200);
  const r=response.json();assert.deepEqual(r.proxies,ips);assert.equal(r.monitoring.available,false);assert.equal(r.monitoring.nodes[0].cpu_percent,null);assert.deepEqual(calls,['tenant-a','tenant-a']);
  assert.equal((await app.inject({url:'/v1/overview/resources?workspace=tenant-b',headers})).statusCode,400);
  const worker={authorization:`Bearer ${await issueToken({subject:'resource-worker',workspace_id:'tenant-a',role:'worker'},key)}`};
  assert.equal((await app.inject({url:'/v1/overview/resources',headers:worker})).statusCode,403);assert.equal(calls.length,2);
 }finally{await app.close();}
});
