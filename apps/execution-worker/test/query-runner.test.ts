import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type {ExecutionApi} from '@crawlsystem/execution-client/http';
import type {LeaseClient} from '../src/youtube/transport.ts';
import {FingerprintError,type FingerprintClient} from '../src/youtube/fingerprint.ts';
import {runQueries} from '../src/query-runner.ts';
test('an unavailable browser holds search admission and remains retryable without cancelling an admitted run',async()=>{
 const stop=new AbortController();let accepting=false,claims=0,released=0,unavailable=0,report:any;
 let entered!:()=>void,finish!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),release=new Promise<void>(resolve=>{finish=resolve;});
 const run={run_id:randomUUID(),binding_id:randomUUID(),attempt:1,lease_expires_at:new Date(Date.now()+60000).toISOString(),params:{text:'test',country:'BR',language:'pt',category:'Music' as const,window:'THIS_YEAR' as const,sort:'popularity' as const,max_pages:5,continue_min_new:3,min_subscribers:1000,policy_version:'query-clock-2-about'}};
 const api={claimQueryRun:async()=>{claims++;return {run,idle_reason:null,retry_after_ms:0};},queryRunFail:async(_id:string,value:unknown)=>{report=value;return {state:'PENDING',retry_at:new Date().toISOString()};}} as unknown as ExecutionApi;
 const proxies={acquire:async()=>({proxy_id:'test',lease_id:'test',proxy_url:'https://127.0.0.1',expires_at:Date.now()+60000}),release:async(_lease:unknown,outcome:string)=>{released++;assert.equal(outcome,'success','gateway readiness is not a bad proxy');}} as unknown as LeaseClient;
 const gateway={withProfile:async(_lease:unknown,signal:AbortSignal)=>{entered();await release;assert.equal(signal.aborted,false,'closing admission lets existing searches finish');throw new FingerprintError('gateway');}} as unknown as FingerprintClient;
 const loop=runQueries({api,proxies,gateway,workerId:'test',signal:stop.signal,log:()=>{},accepting:()=>accepting,unavailable:()=>{unavailable++;accepting=false;}});
 try{await delay(20);assert.equal(claims,0,'an unready browser must not claim any search');accepting=true;await started;accepting=false;finish();await delay(30);assert.equal(claims,1);assert.equal(unavailable,1);assert.equal(report.reason,'network');assert.equal(report.retryable,true);assert.equal(released,1);}finally{finish();stop.abort();await loop;}
});
