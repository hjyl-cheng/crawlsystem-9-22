import { writeFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { Store } from '@crawlsystem/store';
import { createPool } from '@crawlsystem/store/config';
import { createWorkflowStarter } from '@crawlsystem/execution-client';
import { watchTlsFiles } from '@crawlsystem/execution-client/config';
import { RequestTracing } from '@crawlsystem/http/tracing';
import { IntentDispatcher } from './dispatcher.ts';
import { ProxyStore } from '@crawlsystem/store/proxies';
import { CredentialBox } from '@crawlsystem/store/credentials';
import { refreshReferences } from '@crawlsystem/store/feature-clocks';
import { fetchProxySource } from './proxy-source-fetch.ts';
import { checkProxyExit } from '@crawlsystem/execution-client/proxy-exit';
import { proxyUrlOf } from '@crawlsystem/execution-client/proxy-connect';
import { temporalOptions } from './temporal-config.ts';
import { discoveryLimits, updateLimits } from './update-config.ts';
function required(name:string):string {const value=process.env[name];if(!value)throw new Error(`${name} is required`);return value;}
// The real Temporal adapter is linked statically; there is no mock workflow fallback.
const starter=await createWorkflowStarter(temporalOptions());
const tracing=new RequestTracing('intent-dispatcher',record=>process.stdout.write(JSON.stringify({time:new Date().toISOString(),...record})+'\n'),Number(process.env.TRACE_SAMPLE_RATIO??'0.1'));
const pool=createPool(),store=new Store(pool,updateLimits(),discoveryLimits(),{enabled:process.env.PIPELINE_ENABLED==='true'}),dispatcher=new IntentDispatcher(store,starter,required('M1_WORKSPACE_ID'),tracing);
let stopping=false;process.once('SIGINT',()=>{stopping=true;});process.once('SIGTERM',()=>{stopping=true;});
// Renewed mTLS files: exit cleanly (intents are leased) and let Kubernetes restart us.
watchTlsFiles(process.env,()=>{process.stderr.write('Temporal client certificate changed; restarting\n');stopping=true;});
// Liveness: a hung loop stops touching this file and the probe restarts the Pod.
const alive=process.env.DISPATCHER_ALIVE_FILE;
// Proxy subscription sources are refreshed here too: one leased source at a time, off the request path.
const proxies=new ProxyStore(pool,process.env.PROXY_CREDENTIAL_KEY_FILE?CredentialBox.fromFile(process.env.PROXY_CREDENTIAL_KEY_FILE):undefined);
let nextSourceCheck=0;
async function refreshSources(){
  if(Date.now()<nextSourceCheck)return;
  nextSourceCheck=Date.now()+30_000;
  for(let i=0;i<3&&!stopping;i++){
    const claim=await proxies.claimDueSource(120,required('M1_WORKSPACE_ID'));
    if(!claim)return;
    const result=await fetchProxySource(claim.url,claim.etag);
    const applied=await proxies.applySourceFetch(claim,result);
    process.stdout.write(JSON.stringify({time:new Date().toISOString(),event:'proxy_source_refresh',source_id:claim.source_id,status:result.status,...applied})+'\n');
  }
}
// Exit country of every proxy as YouTube sees it (plan R2): checked shortly after import, failed
// checks retried with backoff, successful ones rechecked weekly. Bounded per round and in parallel.
let nextExitCheck=0;
async function checkProxyExits(){
  if(Date.now()<nextExitCheck)return;
  nextExitCheck=Date.now()+20_000;
  const due=await proxies.claimExitChecks(required('M1_WORKSPACE_ID'),16);
  if(!due.length)return;
  const results=new Map<string,number>();
  for(let i=0;i<due.length;i+=8){
    await Promise.all(due.slice(i,i+8).map(async proxy=>{
      const result=await checkProxyExit(proxyUrlOf(proxy));
      await proxies.recordExitCheck(required('M1_WORKSPACE_ID'),proxy.proxy_id,result);
      const key=result.ok?result.country:`failed:${result.error}`;results.set(key,(results.get(key)??0)+1);
    }));
  }
  process.stdout.write(JSON.stringify({time:new Date().toISOString(),event:'proxy_exit_checks',checked:due.length,results:Object.fromEntries(results)})+'\n');
}
// Update clocks rank growth against the day's cross-channel distributions: built once per UTC day.
let nextReferenceCheck=0;
async function refreshClockReferences(){
  if(Date.now()<nextReferenceCheck)return;
  nextReferenceCheck=Date.now()+600_000;
  const done=await refreshReferences(pool,required('M1_WORKSPACE_ID'));
  if(done)process.stdout.write(JSON.stringify({time:new Date().toISOString(),event:'clock_reference_refresh',...done})+'\n');
}
try {
  let nextUpdateScan=0;
  while(!stopping) {
    if(alive)writeFileSync(alive,String(Date.now()));
    try {
      await refreshSources();await refreshClockReferences();await checkProxyExits();
      if(Date.now()>=nextUpdateScan){
        // Qualified candidates join the import queue first, so the same scan can plan them.
        const admitted=await store.admitCandidates(required('M1_WORKSPACE_ID'));
        if(admitted.length)process.stdout.write(JSON.stringify({time:new Date().toISOString(),event:'candidates_admitted',count:admitted.length})+'\n');
        const plans=await store.scheduleUpdates(required('M1_WORKSPACE_ID'));
        nextUpdateScan=Date.now()+30_000;
        if(plans.length)process.stdout.write(JSON.stringify({time:new Date().toISOString(),event:'updates_scheduled',plan_ids:plans.map(p=>p.plan_id)})+'\n');
      }
      const worked=await dispatcher.tick();if(!worked)await setTimeout(1000);
    }
    catch {process.stderr.write('Dispatcher dependency unavailable; durable intents retained\n');await setTimeout(3000);}
  }
} finally {await tracing.close();await starter.close();await pool.end();}
