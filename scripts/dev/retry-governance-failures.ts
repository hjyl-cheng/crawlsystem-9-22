import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createPool} from '@crawlsystem/store/config';
import {workerCapacity} from '../../packages/store/src/workers.ts';
import {client,workspace} from './finish-common.ts';

// Explicit operator retries, one replacement per channel. Persist command IDs
// before calling the API so interrupted runs can resume without double admission.
const file='.runtime/failure-governance/retry-actions.json',pool=createPool();
assert.equal(new URL(process.env.DATABASE_URL!).pathname,'/crawlsystem_m1_main_test');
assert.equal(process.argv[2],'apply','Use apply to execute the reviewed retry candidates');
type Entry={failure_id:string;plan_id:string;channel_id:string;plan_kind:string;command?:unknown;result?:{state:string;retry_plan_id:string|null};settled?:string;deferred?:number};
let audit:{started_at:string;items:Entry[];last_run_at?:string};
const save=()=>writeFileSync(file,JSON.stringify(audit,null,2)+'\n',{mode:0o600});
try {
 if(existsSync(file))audit=JSON.parse(readFileSync(file,'utf8'));
 else {
  // The candidate audit comes from a prior read-only classification. Never add
  // newly failing channels to a run that the operator already reviewed.
  const candidates=JSON.parse(readFileSync('.runtime/failure-governance/retry-candidates.json','utf8'));
  const grouped=new Map<string,any[]>();
  for(const f of candidates.items){const group=grouped.get(f.channel_id)??[];group.push(f);grouped.set(f.channel_id,group);}
  const items:Entry[]=[];
  for(const failures of grouped.values()) {
   const latest=(await pool.query('SELECT plan_id,status FROM control.plans WHERE workspace_id=$1 AND channel_id=$2 ORDER BY created_at DESC LIMIT 1',[workspace,failures[0].channel_id])).rows[0];
   if(latest?.status!=='FAILED')continue;
   const eligible=failures.filter(f=>f.plan_id===latest.plan_id&&f.retryable&&['BUDGET_EXHAUSTED','REPLAY_INCOMPLETE','UNAVAILABLE'].includes(f.code));
   eligible.sort((a,b)=>Number(b.code==='BUDGET_EXHAUSTED')-Number(a.code==='BUDGET_EXHAUSTED'));
   const f=eligible[0];if(f)items.push({failure_id:f.failure_id,plan_id:f.plan_id,channel_id:f.channel_id,plan_kind:f.context.plan_kind});
  }
  items.sort((a,b)=>Number(b.plan_kind==='UPDATE')-Number(a.plan_kind==='UPDATE'));
  assert.ok(items.length<=20,'Review a larger recovery separately');
  audit={started_at:new Date().toISOString(),items};save();
 }
 const {api,headers}=await client(),until=Date.now()+210_000;
 while(Date.now()<until&&audit.items.some(i=>!i.result&&!i.settled)) {
  for(const item of audit.items.filter(i=>!i.result&&!i.settled)) {
   const current=await api('/v1/failures/'+item.failure_id);
   if(!['OPEN','RETRYING'].includes(current.state)){item.settled=current.state;save();continue;}
   if(current.state==='RETRYING'){item.result={state:current.state,retry_plan_id:current.retry_plan_id};save();continue;}
   if(!current.retryable)continue;
   const latest=(await pool.query('SELECT plan_id FROM control.plans WHERE workspace_id=$1 AND channel_id=$2 ORDER BY created_at DESC LIMIT 1',[workspace,item.channel_id])).rows[0];
   if(latest.plan_id!==item.plan_id){item.settled='SUPERSEDED';save();continue;}
   const capacity=await workerCapacity(pool,workspace);
   if(capacity.active_plans>=capacity.slots)break;
   // Refresh the version after admission checks. All writes go through the
   // existing API's workspace, version, channel and quota protections.
   const refreshed=await api('/v1/failures/'+item.failure_id);
   if(refreshed.state!=='OPEN'||!refreshed.retryable)continue;
   const previous=item.command as {expected_version:number}|undefined;
   if(!previous||previous.expected_version!==refreshed.version)item.command={command_id:randomUUID(),expected_version:refreshed.version,action:'retry',reason:'运营治理：解析器回放修复已上线，对当前失败计划执行一次受控重试；保留旧执行和证据。'};
   save();
   const response=await fetch('http://127.0.0.1:18103/api/v1/failures/'+item.failure_id+'/commands',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(item.command),signal:AbortSignal.timeout(30_000)});
   const result=await response.json();
   if(response.status===409){item.deferred=(item.deferred??0)+1;save();continue;}
   assert.equal(response.status,200,'Failure retry API');assert.equal(result.state,'RETRYING');
   item.result={state:result.state,retry_plan_id:result.retry_plan_id};save();
   console.log(JSON.stringify({retried:item.failure_id,kind:item.plan_kind,replacement_plan_id:result.retry_plan_id}));
  }
  if(audit.items.every(i=>i.result||i.settled)||process.argv[3]==='once')break;
  await delay(3_000);
 }
 audit.last_run_at=new Date().toISOString();save();
 console.log(JSON.stringify({result:'PASSED',candidates:audit.items.length,retried:audit.items.filter(i=>i.result).length,settled_or_superseded:audit.items.filter(i=>i.settled).length,waiting_for_admission:audit.items.filter(i=>!i.result&&!i.settled).length}));
}catch(error){
 writeFileSync('.runtime/failure-governance/retry-error.json',JSON.stringify({at:new Date().toISOString(),name:error instanceof Error?error.name:'UnknownError',message:error instanceof Error?error.message:undefined},null,2)+'\n',{mode:0o600});
 console.error(JSON.stringify({result:'FAILED',error:error instanceof Error?error.name:'UnknownError'}));process.exitCode=1;
}
finally {await pool.end();}
