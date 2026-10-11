import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {createPool} from '@crawlsystem/store/config';
// Explicit IDs from the first D2 Worker startup logs, all rejected before its gateway was ready.
const ids=['bbac2bfb-a332-4f5d-9bbf-d35c964d8883','414e6d23-34b5-4567-9c62-c1f83f3ba5ce','532499c9-130d-43fb-8476-3ee436343c54','8255d67c-3749-4c0a-b735-7aca7e9dfd23','deb69d2f-237e-45b0-8c42-47d4c3e9c712','928baa6d-70ab-4e8e-9776-f7fe450da78f','c515267f-f399-4ae2-a6f5-d9aaef78b687','ea7dcc4e-fa85-412d-9273-7f6c55aa9a40','7b4ad41e-54a5-4bd7-b2a9-f529415d30fa','c0b7f2ff-ecd9-487c-ba54-0de87d4934e5'];
const pool=createPool(),client=await pool.connect(),dir='.runtime/d2';
try{
 assert.equal(new URL(process.env.DATABASE_URL!).pathname,'/crawlsystem_m1_main_test');await client.query('BEGIN');
 await client.query("SELECT pg_advisory_xact_lock(hashtext('worker-admission:m1-main'))");
 assert.equal((await client.query("SELECT desired_mode FROM control.workers WHERE workspace_id='m1-main' AND worker_id='execution-worker-0'")).rows[0].desired_mode,'PAUSED');
 const rows=(await client.query("SELECT * FROM control.query_runs WHERE workspace_id='m1-main' AND run_id=ANY($1::uuid[]) ORDER BY run_id FOR UPDATE",[ids])).rows;assert.equal(rows.length,10);
 if(rows.every(r=>r.state!=='FAILED')){await client.query('ROLLBACK');console.log('D2 startup searches already restored');}
 else{
  for(const r of rows){assert.equal(r.state,'FAILED');assert.equal(r.last_error,'internal');assert.ok(new Date(r.finished_at).getTime()>=Date.parse('2026-10-11T03:51:53Z')&&new Date(r.finished_at).getTime()<Date.parse('2026-10-11T03:51:57Z'));}
  const bindings=(await client.query('SELECT * FROM control.query_bindings WHERE binding_id=ANY($1::uuid[]) FOR UPDATE',[rows.map(r=>r.binding_id)])).rows;
  writeFileSync(dir+'/search-startup-before.json',JSON.stringify({runs:rows,bindings},null,2),{mode:0o600});
  await client.query("UPDATE control.query_runs SET state='PENDING',last_error='network',retry_at=clock_timestamp(),finished_at=NULL,last_worker_id='execution-worker-0' WHERE workspace_id='m1-main' AND run_id=ANY($1::uuid[])",[ids]);
  await client.query('UPDATE control.query_bindings SET retry_at=clock_timestamp() WHERE binding_id=ANY($1::uuid[])',[rows.map(r=>r.binding_id)]);
  const after=(await client.query('SELECT * FROM control.query_runs WHERE run_id=ANY($1::uuid[]) ORDER BY run_id',[ids])).rows;
  for(let i=0;i<rows.length;i++)for(const field of ['params','attempt','failures','created_at','started_at','binding_id','error_evidence'])assert.deepEqual(after[i][field],rows[i][field],field+' must remain frozen');
  await client.query('COMMIT');
  writeFileSync(dir+'/search-startup-recovery.json',JSON.stringify({at:new Date().toISOString(),count:10,run_ids:ids,state:'PENDING',parameters_preserved:true,attempts_preserved:true,failure_budgets_preserved:true,created_at_preserved:true,new_runs_created:0,original_evidence_preserved:true},null,2),{mode:0o600});console.log('D2 restored ten frozen search runs for retry; no attempts, failure counts or daily budgets reset');
 }
}catch(e){await client.query('ROLLBACK').catch(()=>{});console.error('D2 startup recovery failed:',e instanceof Error?e.name:'UnknownError');process.exitCode=1;}finally{client.release();await pool.end();}
