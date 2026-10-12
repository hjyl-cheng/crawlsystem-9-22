import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ChannelImport, Principal, UpdateLimits } from '@crawlsystem/contracts';
import { parseChannelReference } from '@crawlsystem/contracts';
import { apiBudget } from './update-budget.ts';
import { StoreError } from './index.ts';
export interface HandleGuard {
 permit(endpoint:'channels'|'playlistItems'|'videos'):Promise<string|undefined>;
 failed?(id:string|undefined,endpoint:'channels'|'playlistItems'|'videos',error:{kind:'quota'|'forbidden'|'not_found'|'invalid'|'unavailable'}):Promise<void>;
}
export type HandleResolver=(handle:string,guard:HandleGuard,signal:AbortSignal)=>Promise<string|null>;
export type HandleResult={channel_id:string|null;outcome?:'handle_not_found'|'resolution_unavailable'|'quota_exhausted'|'handle_unsupported'};
export async function resolveImportHandles(pool:Pool,principal:Principal,command:ChannelImport,limits:UpdateLimits,resolver?:HandleResolver):Promise<Map<string,HandleResult>> {
 const handles=[...new Set(command.lines.flatMap(line=>{const ref=parseChannelReference(line);return ref&&'handle' in ref?[ref.handle.toLowerCase()]:[];}))],results=new Map<string,HandleResult>();
 if(!handles.length)return results;
 const cached=(await pool.query(`SELECT handle,channel_id FROM control.handle_resolutions WHERE workspace_id=$1 AND handle=ANY($2::text[]) AND resolved_at>clock_timestamp()-CASE WHEN channel_id IS NULL THEN interval '10 minutes' ELSE interval '1 hour' END`,[principal.workspace_id,handles])).rows;
 for(const c of cached)results.set(c.handle,{channel_id:c.channel_id,...(c.channel_id?{}:{outcome:'handle_not_found' as const})});
 const pending=handles.filter(h=>!results.has(h)),signal=AbortSignal.timeout(20000);let next=0;
 await Promise.all(Array.from({length:Math.min(3,pending.length)},async()=>{
  for(;;){const handle=pending[next++];if(!handle)return;
   if(!resolver){results.set(handle,{channel_id:null,outcome:'handle_unsupported'});continue;}
   if(signal.aborted){results.set(handle,{channel_id:null,outcome:'resolution_unavailable'});continue;}
   const guard:HandleGuard={
    async permit(endpoint){
     if(endpoint!=='channels')throw new StoreError('INVALID_REQUEST','Unexpected handle resolution endpoint',400);
     const client=await pool.connect();
     try{await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'");
      const budget=await apiBudget(client,principal.workspace_id,new Date(),true);
      if(budget.used+budget.reserved>=limits.api_daily_limit)throw new StoreError('BUDGET_EXHAUSTED','Handle resolution daily quota exhausted');
      const id=randomUUID();await client.query('UPDATE control.data_api_budget SET used_units=used_units+1 WHERE workspace_id=$1 AND quota_day=$2',[principal.workspace_id,budget.day]);
      await client.query("INSERT INTO control.data_api_permits(workspace_id,request_id,import_request_id,quota_day,granted_at,endpoint) VALUES($1,$2,$3,$4,clock_timestamp(),'channels')",[principal.workspace_id,id,command.request_id,budget.day]);
      await client.query('COMMIT');return id;
     }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
    },
    async failed(id,_endpoint,error){if(id)await pool.query('UPDATE control.data_api_permits SET failure=$4,failed_at=clock_timestamp() WHERE workspace_id=$1 AND request_id=$2 AND import_request_id=$3 AND failure IS NULL',[principal.workspace_id,id,command.request_id,error.kind]);}
   };
   try{
    const id=await resolver(handle,guard,signal);
    if(id&&!/^UC[A-Za-z0-9_-]{22}$/.test(id))throw new Error('Invalid handle resolution');
    await pool.query(`INSERT INTO control.handle_resolutions(workspace_id,handle,channel_id) VALUES($1,$2,$3) ON CONFLICT(workspace_id,handle) DO UPDATE SET channel_id=EXCLUDED.channel_id,resolved_at=clock_timestamp()`,[principal.workspace_id,handle,id]);
    results.set(handle,{channel_id:id,...(id?{}:{outcome:'handle_not_found' as const})});
   }catch(error){results.set(handle,{channel_id:null,outcome:error instanceof StoreError&&error.code==='BUDGET_EXHAUSTED'||(error as {kind?:string}).kind==='quota'?'quota_exhausted':'resolution_unavailable'});}
  }
 }));
 return results;
}
