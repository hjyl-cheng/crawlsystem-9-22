import {z} from 'zod';
import {NodeResourcesSchema,type NodeResources} from '@crawlsystem/contracts';

const queries={
 cpu:'100*(1-avg by (node)(rate(node_cpu_seconds_total{job="nodes",mode="idle"}[2m])))',
 total:'max by (node)(node_memory_MemTotal_bytes{job="nodes"})',
 available:'max by (node)(node_memory_MemAvailable_bytes{job="nodes"})',
 sampled:'min by (node)(timestamp(node_memory_MemTotal_bytes{job="nodes"}))',
 up:'max by (node)(up{job="nodes"})',
};
const responseSchema=z.object({status:z.literal('success'),data:z.object({resultType:z.literal('vector'),result:z.array(z.object({metric:z.object({node:z.string().max(160)}),value:z.tuple([z.number(),z.string().max(80)])})).max(1000)})});
export const unknownNode=(server_id:string):NodeResources=>({server_id,cpu_percent:null,memory_used_bytes:null,memory_total_bytes:null,sampled_at:null});
/** Fixed queries only; tenant filtering uses the caller's registered Worker nodes. */
export class Prometheus {
 constructor(private origin:string,private request:typeof fetch=fetch){const u=new URL(origin);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw new Error('Invalid monitoring origin');}
 private async query(query:string){
  const u=new URL('/api/v1/query',this.origin);u.searchParams.set('query',query);
  const response=await this.request(u,{signal:AbortSignal.timeout(4000),redirect:'error'});
  if(!response.ok)throw new Error('Monitoring unavailable');
  const reader=response.body?.getReader();if(!reader)throw new Error('Monitoring unavailable');
  const chunks:Uint8Array[]=[];let bytes=0;
  try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>1048576)throw new Error('Monitoring unavailable');chunks.push(part.value);}}finally{await reader.cancel();}
  const result=responseSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  return new Map(result.data.result.map(r=>[r.metric.node,Number(r.value[1])]));
 }
 async nodes(serverIds:string[],now=Date.now()):Promise<NodeResources[]>{
  if(!serverIds.length)return [];
  const values=await Promise.all(Object.values(queries).map(q=>this.query(q)));
  const [cpu,total,available,sampled,up]=values;
  return serverIds.map(server_id=>{
   const key=server_id.replace(/^crawl-/,''),at=sampled!.get(key),size=total!.get(key),free=available!.get(key),percent=cpu!.get(key);
   if(up!.get(key)!==1||at===undefined||!Number.isFinite(at)||now/1000-at>120||at>now/1000+5)return unknownNode(server_id);
   const memoryValid=Number.isSafeInteger(size)&&Number.isSafeInteger(free)&&size!>0&&free!>=0&&free!<=size!;
   return NodeResourcesSchema.parse({server_id,sampled_at:new Date(at*1000).toISOString(),cpu_percent:percent!==undefined&&Number.isFinite(percent)&&percent>=0&&percent<=100?percent:null,memory_total_bytes:memoryValid?size:null,memory_used_bytes:memoryValid?size!-free!:null});
  });
 }
}
