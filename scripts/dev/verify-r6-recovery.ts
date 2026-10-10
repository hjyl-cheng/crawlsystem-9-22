import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {createPool} from '@crawlsystem/store/config';
import {issueToken,loadSigningKey} from '@crawlsystem/http/auth';
import {FailureSchema} from '@crawlsystem/contracts/analytics';

const mode=process.argv[2]??'plan';assert.ok(['plan','search','final'].includes(mode));
const kube=(args:string[])=>execFileSync('kubectl',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:180000}).trim();
const pool=createPool(),workspace='m1-main',file='.runtime/r6/recovery-state.json';
const state:any=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};
const baseline=JSON.parse(readFileSync('.runtime/r6/state.json','utf8'));
const save=()=>writeFileSync(file,JSON.stringify(state,null,2),{mode:0o600});
const token=await issueToken({subject:'r6-recovery-acceptance',workspace_id:workspace,role:'operator'},loadSigningKey(),1800);
const base=`http://${kube(['-n','control','get','svc','control-api-preview','-o','jsonpath={.spec.clusterIP}'])}:18100`;
async function api(path:string,body?:unknown) {
  const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,...(body===undefined?{}:{'content-type':'application/json'})},
    body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});assert.ok(r.ok,`Recovery HTTP ${r.status}`);return r.json();
}
async function retry(id:string,key:string,reason:string) {
  if(!state[key]){const f=FailureSchema.parse(await api(`/v1/failures/${id}`));assert.ok(f.retryable);state[key]={command_id:randomUUID(),expected_version:f.version,action:'retry',reason};save();}
  return api(`/v1/failures/${id}/commands`,state[key]);
}
try {
  if(mode==='plan') {
    if(!state.agent_failure_id){state.agent_failure_id=(await pool.query("SELECT failure_id FROM control.failures WHERE workspace_id=$1 AND first_at>=$2 AND stage='AGENT' AND code='INVALID_REQUEST' ORDER BY first_at LIMIT 1",[workspace,baseline.started_at])).rows[0]?.failure_id;assert.ok(state.agent_failure_id);save();}
    if(!state.retry_plan_id) {
      for(const end=Date.now()+90000;;) {
        const busy=(await pool.query("SELECT count(*)::int AS n FROM control.plans WHERE workspace_id=$1 AND status IN ('QUEUED','RUNNING','WAITING')",[workspace])).rows[0].n;
        if(busy<2)break;assert.ok(Date.now()<end);await delay(1000);
      }
      const result=FailureSchema.parse(await retry(state.agent_failure_id,'agent_command','R6：画像已支持 NEWEST_FIRST，保留失败计划并通过新计划重试'));
      state.retry_plan_id=result.retry_plan_id;assert.ok(state.retry_plan_id);save();
    }
    console.log(JSON.stringify({phase:'retry-plan',plan_id:state.retry_plan_id}));
  }else if(mode==='search') {
    if(!state.search_failure_id){const f=(await pool.query("SELECT failure_id,run_id FROM control.failures WHERE workspace_id=$1 AND first_at>=$2 AND stage='SEARCH' AND code='INTERNAL' ORDER BY first_at LIMIT 1",[workspace,baseline.started_at])).rows[0];assert.ok(f);state.search_failure_id=f.failure_id;state.search_run_id=f.run_id;save();}
    const prior=(await pool.query('SELECT state,attempt FROM control.query_runs WHERE run_id=$1',[state.search_run_id])).rows[0];
    if(prior.state==='PENDING'&&state.claim&&prior.attempt===state.claim.run.attempt){state.failed_claims??=[];state.failed_claims.push(state.claim);delete state.claim;save();}
    if(prior.state!=='SUCCEEDED') {
      if(!state.claim) {
        await retry(state.search_failure_id,'search_command','R6：修复旧搜索重试漏报历史发现；有界维护恢复原任务与冻结参数');
        const client=await pool.connect();
        try {
          await client.query('BEGIN');const run=(await client.query('SELECT * FROM control.query_runs WHERE run_id=$1 FOR UPDATE',[state.search_run_id])).rows[0];
          assert.equal(run.state,'PENDING');assert.equal(run.params.policy_version,'query-clock-1');assert.ok(run.params.max_pages<=5);
          assert.equal((await client.query("SELECT count(*)::int AS n FROM control.query_runs WHERE workspace_id=$1 AND state='RUNNING'",[workspace])).rows[0].n,0);
          const attempt=run.attempt+1,lease=new Date(Date.now()+5*60000).toISOString();
          // One operator recovery, within the normal concurrency cap; backlog still stops new automatic searches.
          await client.query("UPDATE control.query_runs SET state='RUNNING',attempt=$2,worker_id='execution-worker-0',lease_expires_at=$3,retry_at=NULL WHERE run_id=$1",[run.run_id,attempt,lease]);
          state.claim={run:{run_id:run.run_id,binding_id:run.binding_id,attempt,lease_expires_at:lease,params:run.params},idle_reason:null,retry_after_ms:0};
          await client.query('COMMIT');save();
        }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
      }
      const claimFile='.runtime/r6/legacy-retry-claim.json';writeFileSync(claimFile,JSON.stringify(state.claim),{mode:0o600});
      kube(['-n','crawler','cp',claimFile,'execution-worker-0:/tmp/r6-legacy-retry.json','-c','worker']);
      console.log(kube(['-n','crawler','exec','execution-worker-0','-c','worker','--','node','/app/worker/src/query-once.mjs','/tmp/r6-legacy-retry.json','--legacy-retry']));
    }
    const run=(await pool.query('SELECT state,params,new_channels,qualified_new,clock_settled_at FROM control.query_runs WHERE run_id=$1',[state.search_run_id])).rows[0];
    assert.equal(run.state,'SUCCEEDED');assert.deepEqual(run.params,state.claim.run.params);assert.ok(run.clock_settled_at);
    state.search_recovered=true;state.search_result={new_channels:run.new_channels,qualified_new:run.qualified_new};save();console.log(JSON.stringify({result:'PASSED',phase:'legacy-search-recovery',...state.search_result}));
  }else {
    assert.ok(state.search_recovered);const plan=(await pool.query('SELECT status FROM control.plans WHERE plan_id=$1',[state.retry_plan_id])).rows[0];assert.equal(plan.status,'COMPLETED');
    assert.equal((await pool.query('SELECT state FROM control.channel_imports WHERE workspace_id=$1 AND plan_id=$2',[workspace,state.retry_plan_id])).rows[0]?.state,'done');
    const agent=FailureSchema.parse(await api(`/v1/failures/${state.agent_failure_id}`));assert.equal(agent.state,'RESOLVED');
    const duplicate=(await pool.query("SELECT failure_id FROM control.failures WHERE plan_id=$1 AND state='OPEN' AND stage='WORKER' AND code='INVALID_REQUEST'",[agent.plan_id])).rows;
    for(const row of duplicate){const f=FailureSchema.parse(await api(`/v1/failures/${row.failure_id}`));await api(`/v1/failures/${f.failure_id}/commands`,{command_id:randomUUID(),expected_version:f.version,action:'ignore',reason:`同一画像失败已由完成计划 ${state.retry_plan_id} 恢复；保留原失败与证据`});}
    const search=FailureSchema.parse(await api(`/v1/failures/${state.search_failure_id}`));assert.equal(search.state,'RESOLVED');
    state.plan_recovered=true;state.import_recovered=true;state.verified_at=new Date().toISOString();save();console.log(JSON.stringify({result:'PASSED',plan_recovered:true,import_recovered:true,legacy_search_recovered:true}));
  }
}finally{await pool.end();}
