import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {createPool} from '@crawlsystem/store/config';
import {client,workspace} from './finish-common.ts';

// Review one explicit ABOUT network failure after a durable qualification
// rejection. Keep this audit separate from the initial 93-failure cohort.
const id=process.argv[2],pool=createPool(),dir='.runtime/failure-governance';
assert.match(id??'',/^[a-f0-9-]{36}$/);
assert.equal(new URL(process.env.DATABASE_URL).pathname,'/crawlsystem_m1_main_test');
try {
 const proof=(await pool.query(`SELECT f.failure_id,f.plan_id,f.channel_id,q.passed,q.reason
  FROM control.failures f JOIN control.plans p USING(plan_id) JOIN control.plan_qualifications q USING(plan_id)
  WHERE f.workspace_id=$1 AND f.failure_id=$2 AND f.stage='WORKER' AND f.code='UNAVAILABLE' AND f.step='ABOUT'
    AND p.status='CANCELLED' AND q.passed=false`,[workspace,id])).rows[0];
 assert.ok(proof,'Requires a durable qualification rejection and a cancelled plan');
 const {api}=await client(),current=await api('/v1/failures/'+id),file=dir+'/qualified-close-'+id+'.json';
 const audit=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{proof,command:{command_id:randomUUID(),expected_version:current.version,
  action:'ignore',reason:'运营治理：该计划已有订阅门槛未通过的持久化判定，并按规则取消；关闭已失效的 ABOUT 网络失败，保留原计划和证据。'}};
 const save=()=>writeFileSync(file,JSON.stringify(audit,null,2)+'\n',{mode:0o600});save();
 if(current.state==='OPEN')audit.result=(await api('/v1/failures/'+id+'/commands',audit.command)).state;
 else audit.result=current.state;
 assert.equal(audit.result,'IGNORED');audit.at=new Date().toISOString();save();
 console.log(JSON.stringify({failure_id:id,state:audit.result,qualification_rejected:true,old_plan_status:'CANCELLED'}));
}catch(error){console.error(JSON.stringify({result:'FAILED',error:error.name}));process.exitCode=1;}
finally{await pool.end();}
